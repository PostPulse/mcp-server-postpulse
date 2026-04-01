import { z } from 'zod';
import { createApiClient } from '../api/client';

export const schedulePostTool = {
    name: 'schedule_post',
    description: 'Schedule a social media post to a connected account. Supports Instagram (feed, reel, story), Facebook (feed, reel, story), YouTube, TikTok, Threads, LinkedIn, X/Twitter, Bluesky, and Telegram. Requires an accountId from list_accounts, a platform identifier, and a scheduledTime in ISO-8601 format. For Facebook and Telegram, you MUST first call list_chats to get the publishing destination (Page ID or Channel ID) and pass it as facebookPageId or telegramChannelId respectively. Optionally attach media from upload_media via mediaPaths, set publication type, video title, or topic tag depending on the platform.',
    inputSchema: z.object({
        accountId: z.coerce.number().describe('The account ID from list_accounts'),
        platform: z.string().describe('Platform name (e.g. INSTAGRAM, FACEBOOK, TELEGRAM, YOUTUBE, TIKTOK, THREADS, LINKEDIN, X_TWITTER)'),
        content: z.string().optional().describe('Post content text'),
        mediaPaths: z.array(z.string()).optional().describe('Optional array of media paths from upload_media'),
        scheduledTime: z.string().describe('ISO-8601 timestamp for scheduling (e.g., 2023-10-27T10:00:00Z).'),

        // Platform specific optional fields
        facebookPageId: z.string().optional().describe('Facebook Page ID (required for Facebook). Get it from list_chats with platform=FACEBOOK'),
        telegramChannelId: z.string().optional().describe('Telegram Channel/Chat ID (required for Telegram). Get it from list_chats with platform=TELEGRAM'),
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
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);

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
