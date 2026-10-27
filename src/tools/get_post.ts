import { z } from 'zod';
import { createApiClient } from '../api/client';
import { ApiPost, toPostDetails } from '../api/posts';

export const getPostTool = {
    name: 'get_post',
    description: 'Get one post (by the id from list_posts or schedule_post) with its outcome on each account: platform, status, public link to the published post (url), platform post id, error message if it failed, text, attached media, and the latest metrics PostPulse has for it: impressions, engagements, likes, shares, comments and profileClicks, common to all platforms (a metric is null when the platform does not report it), lastUpdatedTime, and platformAnalytics: the platform\'s own analytics for the post under the platform\'s field names, e.g. view_count on TikTok or views and quotes on Threads. Its fields depend on the platform and the post type, so do not expect a fixed set; it is null when the platform reports none. Metrics of published posts are refreshed from the platform on this call.',
    inputSchema: z.object({
        postId: z.coerce.number().describe('The post id from list_posts or schedule_post'),
    }),
};

export async function handleGetPost({ postId }: { postId: number }, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);
    try {
        const response = await client.get<ApiPost>(`/v1/posts/${postId}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(toPostDetails(response.data), null, 2) }] };
    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}
