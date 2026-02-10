import { createApiClient } from '../api/client';

export const uploadMediaTool = {
    name: 'upload_media',
    description: 'Upload media from a URL for use in scheduled posts. Returns the media path/key.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            url: { type: 'string', format: 'uri', description: 'Public URL of the media file to import' },
        },
        required: ['url'],
    },
};

export async function handleUploadMedia({ url }: any, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const client = createApiClient(token);
    try {
        const importRes = await client.post('/v1/media/upload/import', { url });
        const importId = importRes.data.id;

        const maxRetries = 20;
        const delay = 2000;
        for (let i = 0; i < maxRetries; i++) {
            await new Promise(resolve => setTimeout(resolve, delay));
            const statusRes = await client.get(`/v1/media/upload/import/${importId}`);
            const status = statusRes.data;
            if (status.state === 'COMPLETED') {
                const mediaPath = status.key || status.path || status.id;
                return { content: [{ type: 'text' as const, text: mediaPath.toString() }] };
            }
            if (status.state === 'FAILED') {
                throw new Error(`Media import failed: ${JSON.stringify(status)}`);
            }
        }
        throw new Error('Media import timed out');
    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}
