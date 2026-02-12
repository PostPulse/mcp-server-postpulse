import { z } from 'zod';
import { createApiClient } from '../api/client';
import axios from 'axios';

export const uploadMediaTool = {
    name: 'upload_media',
    description: 'Upload media from a URL or binary data for use in scheduled posts. Returns the media path/key.',
    inputSchema: z.object({
        mediaUrl: z.string().url().describe('The public URL of the media file to upload').optional(),
        mediaData: z.string().describe('Base64 encoded media data').optional(),
        mediaType: z.string().describe('MIME type of the media file (required if mediaData is provided)').optional(),
        mediaName: z.string().describe('Name of the media file').optional(),
    }),
};

export async function handleUploadMedia({ mediaUrl, mediaData, mediaType, mediaName }: { mediaUrl?: string, mediaData?: string, mediaType?: string, mediaName?: string }, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const client = createApiClient(token);

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
            console.log(mediaData.slice(0, 50));
            console.log(buffer.slice(0, 10));
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
                headers: {
                    ...headers,
                    'Content-Type': mediaType
                }
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
