import { z } from 'zod';
import { createApiClient } from '../api/client';
import axios from 'axios';
import { LARGE_FILE_GUIDANCE, MAX_BASE64_FILE_KB, MAX_BODY_KB } from '../body_limit';
import { logger } from '../logger';

/** States in which the backend is still working (its MediaImportState). It retries FAILED_TEMPORARY until READY or FAILED_PERMANENT. */
const IMPORT_IN_FLIGHT = new Set(['QUEUED', 'DOWNLOADING', 'VALIDATING', 'UPLOADING', 'FAILED_TEMPORARY']);
const IMPORT_POLL_INTERVAL_MS = 2000;
/** Clients time out tool calls after about 60 s and an import may take far longer, so a call stops waiting before that. */
export const IMPORT_WAIT_MS = 50_000;
/** A status read close to the deadline still gets a moment to answer. */
const IMPORT_MIN_READ_TIMEOUT_MS = 2000;

export const uploadMediaTool = {
    name: 'upload_media',
    description: `Upload a media file for use in scheduled posts. Returns a media key string that you pass to the mediaPaths parameter of schedule_post. Two modes: (1) mediaUrl, a public URL to import from the web (the server handles download and processing automatically); (2) base64-encoded mediaData with a mediaType MIME type, only for files up to about ${MAX_BASE64_FILE_KB} KB, because a request to this server is limited to ${MAX_BODY_KB} KB. Never try mediaData for a video. ${LARGE_FILE_GUIDANCE} Do not ask the user to shrink a file just to upload it: a platform's size limits come back as schedule_post errors. An import that takes long returns its import id and state instead of a key: call upload_media again with importId to keep waiting, and do not start the import again.`,
    inputSchema: z.object({
        mediaUrl: z.string().url().optional().describe('Public URL of the media file to import (e.g. https://example.com/photo.jpg). The server downloads and processes the file automatically. Use this OR mediaData, not both.'),
        mediaData: z.string().optional().describe(`Base64-encoded binary content of a file up to about ${MAX_BASE64_FILE_KB} KB; a larger file fails with a 413 error. Must be used together with mediaType. Use this OR mediaUrl, not both.`),
        mediaType: z.string().optional().describe('MIME type of the file in mediaData (e.g. image/jpeg, image/png). Required when using mediaData.'),
        mediaName: z.string().optional().describe('File name with a media extension (e.g. photo.jpg, clip.mp4). Needed with mediaData, and with mediaUrl when the URL does not end in such a name.'),
        importId: z.coerce.number().int().positive().nullish().describe('Id of an import that upload_media reported as still running. Pass it alone to keep waiting for that import instead of starting a new one.'),
    }),
};

export async function handleUploadMedia({ mediaUrl, mediaData, mediaType, mediaName, importId }: { mediaUrl?: string, mediaData?: string, mediaType?: string, mediaName?: string, importId?: number | null }, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);

    // One line per call. Never add mediaUrl, mediaData or a backend error message here: a signed URL is a
    // bearer secret, and the import status echoes it in its error text.
    const mode = importId ? 'check' : mediaUrl ? 'url' : (mediaData && mediaType ? 'base64' : 'none');
    let sizeBytes: number | undefined;
    let state: string | undefined;
    let currentImportId = importId ?? undefined;
    let importEnded = false;
    const log = (outcome: string, status?: number) => logger.info(
        { tool: 'upload_media', mode, importId: currentImportId, sizeBytes, state, status, outcome, clientId, sub: (extra as any)?.authInfo?.extra?.sub },
        'upload_media finished',
    );

    try {
        if (importId || mediaUrl) {
            const deadline = Date.now() + IMPORT_WAIT_MS;
            if (!importId) {
                const importRes = await client.post(
                    '/v1/media/upload/import',
                    { url: mediaUrl, ...(mediaName ? { filenameHint: mediaName } : {}) },
                    { timeout: IMPORT_WAIT_MS },
                );
                currentImportId = importRes.data.id;
                state = 'QUEUED';
            }

            // Poll while the import is in flight, until the deadline. Looping on the in-flight set (rather
            // than "until READY") means an unrecognised state ends the loop instead of spinning forever.
            let mediaPath: string | undefined;
            // A new import has only just been queued; a check reads at once.
            let pause = !importId;
            do {
                if (pause) {
                    await new Promise((resolve) => setTimeout(resolve, IMPORT_POLL_INTERVAL_MS));
                }
                pause = true;
                // The API client has no timeout of its own, and a read that hangs would outlast the deadline.
                const statusRes = await client.get(`/v1/media/upload/import/${currentImportId}`, {
                    timeout: Math.max(deadline - Date.now(), IMPORT_MIN_READ_TIMEOUT_MS),
                });
                state = statusRes.data.state as string;
                mediaPath = statusRes.data.s3Key;
                sizeBytes = statusRes.data.totalBytes ?? sizeBytes;

                if (state === 'FAILED_PERMANENT') {
                    importEnded = true;
                    const detail = statusRes.data.errorMessage || statusRes.data.errorCode || 'unknown error';
                    throw new Error(`Media import failed (${state}): ${detail}`);
                }
            } while (IMPORT_IN_FLIGHT.has(state) && Date.now() < deadline);

            if (IMPORT_IN_FLIGHT.has(state)) {
                log('still_running');
                return { content: [{ type: 'text' as const, text: `The import is still running on the server (state: ${state}, import id: ${currentImportId}). Call upload_media with importId ${currentImportId} to keep waiting, and do not start the import again.` }] };
            }
            importEnded = true;
            if (state !== 'READY' || !mediaPath) {
                throw new Error(`Media import ended in an unexpected state: ${state}`);
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
                content: [{ type: 'text' as const, text: 'Error: Either mediaUrl, mediaData with mediaType, or importId must be provided.' }],
                isError: true,
            };
        }

    } catch (error: any) {
        log('failed', error.response?.status);
        // A timeout or a 5xx says nothing about the import itself, and starting it again would duplicate it.
        const undecided = currentImportId && !importEnded && (!error.response || error.response.status >= 500);
        const checkHint = undecided ? ` The import may still be running: call upload_media with importId ${currentImportId} to check, and do not start it again.` : '';
        // The API's errors name its own field, and the input of this tool for it is mediaName.
        const detail = error.response?.data ? JSON.stringify(error.response.data).replace(/filenameHint/g, 'mediaName') : '';
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${detail}${checkHint}` }],
            isError: true,
        };
    }
}
