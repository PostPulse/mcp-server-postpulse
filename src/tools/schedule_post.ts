import { z } from 'zod';
import { createApiClient } from '../api/client';

export const schedulePostTool = {
    name: 'schedule_post',
    description: 'Schedule a social media post to a connected account. Supports Instagram (feed, reel, story), Facebook (feed, reel, story), YouTube, TikTok, Threads, LinkedIn, Pinterest, X/Twitter, Bluesky, and Telegram. Requires an accountId from list_accounts (if the user has no account for the platform, use connect_account first), a platform identifier, and a scheduledTime in ISO-8601 format. For Facebook, Telegram and Pinterest, you MUST first call list_chats to get the publishing destination (Page ID, Channel ID or Board ID) and pass it as facebookPageId, telegramChannelId or pinterestBoardId respectively. Pinterest posts require media (1 image, 1 video, or 2-5 images). Optionally attach media from upload_media via mediaPaths, set publication type, title, topic tag, or Pin link/alt text depending on the platform.',
    inputSchema: z.object({
        accountId: z.coerce.number().describe('The account ID from list_accounts'),
        platform: z.string().describe('Platform name (e.g. INSTAGRAM, FACEBOOK, TELEGRAM, YOUTUBE, TIKTOK, THREADS, LINKEDIN, PINTEREST, X_TWITTER)'),
        content: z.string().optional().describe('Post content text'),
        mediaPaths: z.array(z.string().describe('Media key returned by upload_media')).optional().describe('Optional array of media keys from upload_media'),
        scheduledTime: z.string().describe('ISO-8601 timestamp for scheduling (e.g., 2023-10-27T10:00:00Z).'),

        // Platform specific optional fields
        facebookPageId: z.string().optional().describe('Facebook Page ID (required for Facebook). Get it from list_chats with platform=FACEBOOK'),
        telegramChannelId: z.string().optional().describe('Telegram Channel/Chat ID (required for Telegram). Get it from list_chats with platform=TELEGRAM'),
        pinterestBoardId: z.string().optional().describe('Pinterest Board ID (required for Pinterest). Get it from list_chats with platform=PINTEREST'),
        publicationType: z.enum(['FEED', 'REELS', 'STORY']).optional().describe('Publication type for Instagram/Facebook (default: FEED)'),
        title: z.string().optional().describe('Title for YouTube or TikTok videos, or Pinterest Pins (up to 100 characters)'),
        topicTag: z.string().optional().describe('Topic tag for Threads'),
        link: z.string().optional().describe('Pinterest only: destination URL opened when the Pin is clicked'),
        altText: z.string().optional().describe('Pinterest only: alt text describing the Pin image'),
        boardSectionId: z.string().optional().describe('Pinterest only: ID of a section within the board'),
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
        pinterestBoardId,
        publicationType,
        title,
        topicTag,
        link,
        altText,
        boardSectionId
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
        } else if (platform === 'PINTEREST') {
            if (title) platformSettings.title = title;
            if (link) platformSettings.link = link;
            if (altText) platformSettings.altText = altText;
            if (boardSectionId) platformSettings.boardSectionId = boardSectionId;
        }

        // 3. Construct Post Data
        const postData: any = {};
        if (content) postData.content = content;

        // Handle Chat IDs
        if (platform === 'FACEBOOK' && facebookPageId) {
            postData.chatId = facebookPageId;
        } else if (platform === 'TELEGRAM' && telegramChannelId) {
            postData.chatId = telegramChannelId;
        } else if (platform === 'PINTEREST' && pinterestBoardId) {
            postData.chatId = pinterestBoardId;
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
