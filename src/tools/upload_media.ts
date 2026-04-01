import { z } from 'zod';
import { createApiClient } from '../api/client';
import axios from 'axios';

export const uploadMediaTool = {
    name: 'upload_media',
    description: 'Upload media files (images, videos) for use in scheduled posts. Supports two modes: (1) provide a public mediaUrl to import from the web (the server handles download and processing automatically), or (2) provide base64-encoded mediaData with a mediaType MIME type for direct binary upload. Returns a media key string that you pass to the mediaPaths parameter of schedule_post.',
    inputSchema: z.object({
        mediaUrl: z.string().url().optional().describe('Public URL of the media file to import (e.g. https://example.com/photo.jpg). The server downloads and processes the file automatically. Use this OR mediaData, not both.'),
        mediaData: z.string().optional().describe('Base64-encoded binary content of the media file. Must be used together with mediaType. Use this OR mediaUrl, not both.'),
        mediaType: z.string().optional().describe('MIME type of the media file (e.g. image/jpeg, image/png, video/mp4). Required when using mediaData.'),
        mediaName: z.string().optional().describe('Filename for the uploaded media (e.g. photo.jpg). Optional, defaults to "file" if not provided.'),
    }),
};

export async function handleUploadMedia({ mediaUrl, mediaData, mediaType, mediaName }: { mediaUrl?: string, mediaData?: string, mediaType?: string, mediaName?: string }, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);

    try {
        if (mediaUrl) {
            const importRes = await client.post('/v1/media/upload/import', { url: mediaUrl });
            const importId = importRes.data.importId;

            // Poll for status
            let status = 'PENDING';
            let mediaPath = '';
            while (status === 'PENDING' || status === 'PROCESSING') {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                const statusRes = await client.get(`/v1/media/upload/import/${importId}`);
                status = statusRes.data.status;
                mediaPath = statusRes.data.path;

                if (status === 'FAILED') {
                    throw new Error('Media import failed');
                }
            }
            return { content: [{ type: 'text' as const, text: mediaPath }] };

        } else if (mediaData && mediaType) {
            const buffer = Buffer.from(mediaData, 'base64');
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

            return { content: [{ type: 'text' as const, text: key }] };

        } else {
            return {
                content: [{ type: 'text' as const, text: 'Error: Either mediaUrl or (mediaData and mediaType) must be provided.' }],
                isError: true,
            };
        }

    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}
