import { z } from 'zod';
import { createApiClient } from '../api/client';
import { ApiAccount, unknownAccountMessage } from '../api/accounts';

export const schedulePostTool = {
    name: 'schedule_post',
    description: 'Schedule a social media post to a connected account. Supports Instagram (feed, reel, story), Facebook and Facebook Page (feed, reel, story), YouTube, TikTok, Threads, LinkedIn, Pinterest, X/Twitter, Bluesky, Telegram, and WhatsApp broadcasts. A WhatsApp post sends an approved template to a contact list from one phone number: pass whatsappPhoneNumberId (list_chats), contactListId (list_whatsapp_contact_lists), templateName, templateLanguage and the template\'s variables (list_whatsapp_templates); content is not needed, the text comes from the template, and mediaPaths is only the header image or video of a template that has one. Requires an accountId from list_accounts (if the user has no account for the platform, use connect_account first), a platform identifier, and a scheduledTime in ISO-8601 format. For an account whose platform in list_accounts is FACEBOOK, TELEGRAM or PINTEREST, you MUST first call list_chats for that account to get the publishing destination (Page ID, Channel ID or Board ID) and pass it as facebookPageId, telegramChannelId or pinterestBoardId respectively. A FACEBOOK_PAGE account is one Facebook Page (connect_account creates these for Facebook): post to it directly, without list_chats or facebookPageId. Pinterest posts require media (1 image, 1 video, or 2-5 images). With publicationType STORY, each key in mediaPaths becomes its own story, in the order given, and all of them belong to this one post and its scheduledTime. Optionally attach media via mediaPaths (keys from list_media, upload_media or get_upload_link), set publication type, title, topic tag, or Pin link/alt text depending on the platform.',
    inputSchema: z.object({
        accountId: z.coerce.number().int().positive().describe('The account ID from list_accounts'),
        platform: z.string().describe('The account\'s platform exactly as list_accounts returned it (e.g. INSTAGRAM, FACEBOOK, FACEBOOK_PAGE, TELEGRAM, YOUTUBE, TIKTOK, THREADS, LINKEDIN, PINTEREST, X_TWITTER, WHATSAPP)'),
        content: z.string().optional().describe('Post content text (not used for WhatsApp: the text comes from the template)'),
        mediaPaths: z.array(z.string().describe('Media key from list_media, upload_media or get_upload_link, not the file name')).optional().describe('Optional array of media keys from list_media, upload_media or get_upload_link. With publicationType STORY, each key is one story of this post'),
        scheduledTime: z.string().describe('ISO-8601 timestamp for scheduling (e.g., 2023-10-27T10:00:00Z).'),

        // Platform specific optional fields
        facebookPageId: z.string().optional().describe('Facebook Page ID (required when the account\'s platform is FACEBOOK). Get it from list_chats for the FACEBOOK account. Not used for FACEBOOK_PAGE: the account is the Page'),
        telegramChannelId: z.string().optional().describe('Telegram Channel/Chat ID (required for Telegram). Get it from list_chats for the TELEGRAM account'),
        pinterestBoardId: z.string().optional().describe('Pinterest Board ID (required for Pinterest). Get it from list_chats for the PINTEREST account'),
        publicationType: z.enum(['FEED', 'REELS', 'STORY']).optional().describe('Publication type for Instagram/Facebook/Facebook Page (default: FEED). STORY takes one or several media keys'),
        title: z.string().optional().describe('Title for YouTube or TikTok videos, or Pinterest Pins (up to 100 characters)'),
        topicTag: z.string().optional().describe('Topic tag for Threads'),
        link: z.string().optional().describe('Pinterest only: destination URL opened when the Pin is clicked'),
        altText: z.string().optional().describe('Pinterest only: alt text describing the Pin image'),
        boardSectionId: z.string().optional().describe('Pinterest only: ID of a section within the board'),
        whatsappPhoneNumberId: z.string().optional().describe('WhatsApp only (required): the phone number to send from. Get it from list_chats for the WHATSAPP account'),
        contactListId: z.coerce.number().int().positive().optional().describe('WhatsApp only (required): the contact list to send to, from list_whatsapp_contact_lists'),
        templateName: z.string().optional().describe('WhatsApp only (required): name of an approved template from list_whatsapp_templates'),
        templateLanguage: z.string().optional().describe('WhatsApp only (required): language of that template, as list_whatsapp_templates returned it (e.g. en_US)'),
        headerParameter: z.string().optional().describe('WhatsApp only: value of the text header variable, when the template has headerParameterKey'),
        bodyParameters: z.record(z.string(), z.string()).optional().describe('WhatsApp only: body variable values by key, one for every key in the template\'s bodyParameterKeys, e.g. {"1": "20%", "2": "Sunday"}'),
        buttonParameters: z.record(z.string(), z.string()).optional().describe('WhatsApp only: end of the URL of each button with dynamicUrl, by the button\'s index in the template\'s buttons, e.g. {"0": "autumn-2026"}'),
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
        boardSectionId,
        whatsappPhoneNumberId,
        contactListId,
        templateName,
        templateLanguage,
        headerParameter,
        bodyParameters,
        buttonParameters
    } = args;

    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);

    try {
        // 0. The account must be one of the user's: agents send ids from an earlier conversation or of
        // a disconnected account, which the API rejects with a bare "Invalid social media account id".
        const accounts = (await client.get<ApiAccount[]>('/v1/accounts')).data;
        if (!accounts.some((acc) => acc.id === accountId)) {
            return { content: [{ type: 'text' as const, text: unknownAccountMessage(accountId, accounts) }], isError: true };
        }

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
        } else if (platform === 'FACEBOOK' || platform === 'FACEBOOK_PAGE') {
            // A FACEBOOK_PAGE account is the Page itself: same publication types, no chatId
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
        } else if (platform === 'WHATSAPP') {
            // The API checks the template and its variables and takes the post text from the template
            if (contactListId) platformSettings.contactListId = contactListId;
            if (templateName) platformSettings.templateName = templateName;
            if (templateLanguage) platformSettings.templateLanguage = templateLanguage;
            if (headerParameter) platformSettings.headerParameter = headerParameter;
            if (bodyParameters) platformSettings.bodyParameters = bodyParameters;
            if (buttonParameters) platformSettings.buttonParameters = buttonParameters;
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
        } else if (platform === 'WHATSAPP' && whatsappPhoneNumberId) {
            postData.chatId = whatsappPhoneNumberId;
        }

        // Handle Media. The API takes one media per story, and a publication holds any number of stories:
        // same split as the website (postpulse-fe src/api/posts/normalizers.ts). publicationType is set above
        // only for the platforms that have it, so STORY sent for another platform splits nothing.
        const isStory = platformSettings.publicationType === 'STORY';
        let posts: any[] = [postData];
        if (mediaPaths && mediaPaths.length > 0) {
            posts = isStory
                ? mediaPaths.map((mediaPath: string) => ({ ...postData, attachmentPaths: [mediaPath] }))
                : [{ ...postData, attachmentPaths: mediaPaths }];
        }

        // 4. Construct Publication
        const publication = {
            socialMediaAccountId: accountId,
            posts,
            platformSettings,
        };

        // 5. Construct Final Body
        const body = {
            scheduledTime,
            isDraft: false,
            publications: [publication],
        };

        const response = await client.post('/v1/posts', body);
        const stories = isStory && posts.length > 1 ? ` with ${posts.length} stories in the order of mediaPaths` : '';
        return { content: [{ type: 'text' as const, text: `Post scheduled successfully (ID: ${response.data.id})${stories}` }] };

    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}
