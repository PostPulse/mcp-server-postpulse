import { z } from 'zod';
import { createApiClient } from '../api/client';

export const schedulePostTool = {
    name: 'schedule_post',
    description: 'Schedule a social media post to one of your connected accounts. Supports various platforms including Instagram, Facebook, YouTube, TikTok, and more.',
    inputSchema: z.object({
        accountId: z.coerce.number().describe('The account ID from list_accounts'),
        platform: z.string().describe('Platform name (e.g. INSTAGRAM, FACEBOOK, TELEGRAM, YOUTUBE, TIKTOK, THREADS, LINKEDIN, X_TWITTER)'),
        content: z.string().optional().describe('Post content text'),
        mediaPaths: z.array(z.string()).optional().describe('Optional array of media paths from upload_media'),
        scheduledTime: z.string().describe('ISO-8601 timestamp for scheduling (e.g., 2023-10-27T10:00:00Z).'),

        // Platform specific optional fields
        facebookPageId: z.string().optional().describe('Facebook Page ID (required for Facebook if not using default)'),
        telegramChannelId: z.string().optional().describe('Telegram Channel ID (required for Telegram if not using default)'),
        publicationType: z.enum(['FEED', 'REEL', 'STORY']).optional().describe('Publication type for Instagram/Facebook (default: FEED)'),
        title: z.string().optional().describe('Title for YouTube or TikTok videos'),
        topicTag: z.string().optional().describe('Topic tag for Threads'),
    }),
};

export async function handleSchedulePost(args: any, extra: any) {
    const {
        accountId,
        platform,
        content,
        mediaPaths,
        scheduledTime,
        facebookPageId,
        telegramChannelId,
        publicationType,
        title,
        topicTag
    } = args;

    const token = (extra as any)?.authInfo?.token || '';
    const client = createApiClient(token);

    try {
        // 1. Determine API Type
        let apiType = platform;
        if (platform === 'TIKTOK') {
            apiType = 'TIK_TOK';
        } else if (platform === 'X_TWITTER') {
            apiType = 'TWITTER';
        }

        // 2. Construct Platform Settings
        const platformSettings: any = {
            type: apiType,
        };

        if (platform === 'INSTAGRAM') {
            platformSettings.publicationType = publicationType || 'FEED';
        } else if (platform === 'FACEBOOK') {
            platformSettings.publicationType = publicationType || 'FEED';
        } else if (platform === 'YOUTUBE') {
            if (title) platformSettings.title = title;
        } else if (platform === 'TIKTOK') {
            if (title) platformSettings.title = title;
            platformSettings.hasUsageConfirmation = true;
        } else if (platform === 'THREADS') {
            if (topicTag) platformSettings.topicTag = topicTag;
        }

        // 3. Construct Post Data
        const postData: any = {};
        if (content) postData.content = content;

        // Handle Chat IDs
        if (platform === 'FACEBOOK' && facebookPageId) {
            postData.chatId = facebookPageId;
        } else if (platform === 'TELEGRAM' && telegramChannelId) {
            postData.chatId = telegramChannelId;
        }

        // Handle Media
        if (mediaPaths && mediaPaths.length > 0) {
            postData.attachmentPaths = mediaPaths;
        }

        // 4. Construct Publication
        const publication = {
            socialMediaAccountId: accountId,
            posts: [postData],
            platformSettings,
        };

        // 5. Construct Final Body
        const body = {
            scheduledTime,
            isDraft: false,
            publications: [publication],
        };

        const response = await client.post('/v1/posts', body);
        return { content: [{ type: 'text' as const, text: `Post scheduled successfully (ID: ${response.data.id})` }] };

    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}
