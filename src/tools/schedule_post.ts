import { z } from 'zod';
import { createApiClient } from '../api/client';

export const schedulePostTool = {
    name: 'schedule_post',
    description: 'Schedule a social media post to one of your connected accounts.',
    inputSchema: z.object({
        accountId: z.coerce.number().describe('The account ID from list_accounts'),
        platform: z.string().describe('Platform name (e.g. INSTAGRAM, FACEBOOK, TELEGRAM)'),
        text: z.string().describe('Post content text'),
        mediaPaths: z.array(z.string()).optional().describe('Optional array of media paths from upload_media'),
        publishAt: z.string().optional().describe('ISO-8601 timestamp for scheduling. If omitted, posts immediately.'),
    }),
};

export async function handleSchedulePost({ accountId, platform, text, mediaPaths, publishAt }: any, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const client = createApiClient(token);
    try {
        const payload: any = {
            accountId,
            platform,
            text,
            media: (mediaPaths || []).map((path: string) => ({ path })),
        };

        if (publishAt) {
            payload.scheduledPublishTime = publishAt;
        }

        const response = await client.post('/v1/posts', payload);
        return { content: [{ type: 'text' as const, text: `Post scheduled successfully (ID: ${response.data.id})` }] };
    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}
