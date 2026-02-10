import { z } from 'zod';
import { createApiClient } from '../api/client';

export const uploadMediaTool = {
    name: 'upload_media',
    description: 'Upload media from a URL for use in scheduled posts. Returns the media path/key.',
    inputSchema: z.object({
        mediaUrl: z.string().url().describe('The public URL of the media file to upload'),
    }),
};

export async function handleUploadMedia({ mediaUrl }: { mediaUrl: string }, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const client = createApiClient(token);
    try {
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
    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}
