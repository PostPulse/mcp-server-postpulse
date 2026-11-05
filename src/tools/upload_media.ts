import { z } from 'zod';
import { createApiClient } from '../api/client';
import axios from 'axios';
import { LARGE_FILE_GUIDANCE, MAX_BASE64_FILE_KB, MAX_BODY_KB } from '../body_limit';
import { logger } from '../logger';

export const uploadMediaTool = {
    name: 'upload_media',
    description: `Upload a media file for use in scheduled posts. Returns a media key string that you pass to the mediaPaths parameter of schedule_post. Two modes: (1) mediaUrl, a public URL to import from the web (the server handles download and processing automatically); (2) base64-encoded mediaData with a mediaType MIME type, only for files up to about ${MAX_BASE64_FILE_KB} KB, because a request to this server is limited to ${MAX_BODY_KB} KB. Never try mediaData for a video. ${LARGE_FILE_GUIDANCE} Do not ask the user to shrink a file just to upload it: a platform's size limits come back as schedule_post errors.`,
    inputSchema: z.object({
        mediaUrl: z.string().url().optional().describe('Public URL of the media file to import (e.g. https://example.com/photo.jpg). The server downloads and processes the file automatically. Use this OR mediaData, not both.'),
        mediaData: z.string().optional().describe(`Base64-encoded binary content of a file up to about ${MAX_BASE64_FILE_KB} KB; a larger file fails with a 413 error. Must be used together with mediaType. Use this OR mediaUrl, not both.`),
        mediaType: z.string().optional().describe('MIME type of the file in mediaData (e.g. image/jpeg, image/png). Required when using mediaData.'),
        mediaName: z.string().optional().describe('Filename for the uploaded media (e.g. photo.jpg). Optional, defaults to "file" if not provided.'),
    }),
};

export async function handleUploadMedia({ mediaUrl, mediaData, mediaType, mediaName }: { mediaUrl?: string, mediaData?: string, mediaType?: string, mediaName?: string }, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);

    // One line per call. Never add mediaUrl, mediaData or a backend error message here: a signed URL is a
    // bearer secret, and the import status echoes it in its error text.
    const mode = mediaUrl ? 'url' : (mediaData && mediaType ? 'base64' : 'none');
    let sizeBytes: number | undefined;
    let state: string | undefined;
    const log = (outcome: string, status?: number) => logger.info(
        { tool: 'upload_media', mode, sizeBytes, state, status, outcome, clientId, sub: (extra as any)?.authInfo?.extra?.sub },
        'upload_media finished',
    );

    try {
        if (mediaUrl) {
            const importRes = await client.post('/v1/media/upload/import', { url: mediaUrl });
            const importId = importRes.data.id;

            // Poll while the import is in flight. State names come from the backend's
            // MediaImportState enum; looping on the in-flight set (rather than "until READY")
            // means an unrecognised state ends the loop instead of spinning forever.
            state = 'QUEUED';
            let mediaPath = '';
            // FAILED_TEMPORARY is in flight too: the backend retries it until READY or FAILED_PERMANENT.
            while (state === 'QUEUED' || state === 'DOWNLOADING'
                || state === 'VALIDATING' || state === 'UPLOADING' || state === 'FAILED_TEMPORARY') {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                const statusRes = await client.get(`/v1/media/upload/import/${importId}`);
                state = statusRes.data.state as string;
                mediaPath = statusRes.data.s3Key;
                sizeBytes = statusRes.data.totalBytes ?? sizeBytes;

                if (state === 'FAILED_PERMANENT') {
                    const detail = statusRes.data.errorMessage || statusRes.data.errorCode || 'unknown error';
                    throw new Error(`Media import failed (${state}): ${detail}`);
                }
            }
            log('ok');
            return { content: [{ type: 'text' as const, text: mediaPath }] };

        } else if (mediaData && mediaType) {
            const buffer = Buffer.from(mediaData, 'base64');
            sizeBytes = buffer.length;
            const filename = mediaName || 'file';

            // Step 1: Get presigned URL
            const uploadRes = await client.post('/v1/media/upload/urls', {
                filename,
                contentType: mediaType,
                sizeBytes: buffer.length
            });

            const { url, key, headers } = uploadRes.data;
            if (!url || !key) {
                throw new Error('Failed to get upload URL');
            }

            // Step 2: Upload to presigned URL
            await axios.put(url, buffer, {
                headers: headers,
                transformRequest: [(data) => data]
            });

            log('ok');
            return { content: [{ type: 'text' as const, text: key }] };

        } else {
            log('invalid_input');
            return {
                content: [{ type: 'text' as const, text: 'Error: Either mediaUrl or (mediaData and mediaType) must be provided.' }],
                isError: true,
            };
        }

    } catch (error: any) {
        log('failed', error.response?.status);
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}
