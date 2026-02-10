import { createApiClient } from '../api/client';

export const schedulePostTool = {
    name: 'schedule_post',
    description: 'Schedule a social media post to one of your connected accounts.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            accountId: { type: 'number', description: 'Account ID from list_accounts' },
            platform: { type: 'string', description: 'Platform (INSTAGRAM, FACEBOOK, TIKTOK, X_TWITTER, TELEGRAM, LINKEDIN)' },
            content: { type: 'string', description: 'The text content of the post' },
            scheduledTime: { type: 'string', description: 'ISO 8601 date-time for when to publish' },
            mediaPaths: { type: 'array', items: { type: 'string' }, description: 'Media paths from upload_media' },
            chatId: { type: 'string', description: 'Chat/channel ID for Telegram posts' },
        },
        required: ['accountId', 'platform', 'content', 'scheduledTime'],
    },
};

export async function handleSchedulePost({ accountId, platform, content, scheduledTime, mediaPaths, chatId }: any, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const client = createApiClient(token);
    try {
        const platformSettings: any = {};
        if (platform === 'INSTAGRAM') {
            platformSettings.instagram = { postType: (mediaPaths && mediaPaths.length > 0) ? 'POST' : 'POST' };
        } else if (platform === 'FACEBOOK') {
            platformSettings.facebook = { postType: 'POST' };
        } else if (platform === 'TIKTOK') {
            platformSettings.tikTok = { postType: 'VIDEO', privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: true, allowStitch: true };
        } else if (platform === 'X_TWITTER') {
            platformSettings.xTwitter = { postType: 'POST' };
        } else if (platform === 'TELEGRAM') {
            platformSettings.telegram = { postType: 'POST', chatId: chatId || '' };
        } else if (platform === 'LINKEDIN') {
            platformSettings.linkedIn = { postType: 'POST', visibility: 'PUBLIC' };
        }

        const media = (mediaPaths || []).map((p: string) => ({ path: p }));
        const postData: any = { content, media };
        const publications = [{ socialMediaAccountId: accountId, platformSettings, posts: [postData] }];
        const body = { scheduledTime, isDraft: false, publications };

        const response = await client.post('/v1/posts', body);
        return { content: [{ type: 'text' as const, text: JSON.stringify(response.data, null, 2) }] };
    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}
