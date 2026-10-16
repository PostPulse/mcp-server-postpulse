import { z } from 'zod';
import { createApiClient } from '../api/client';

export const listChatsTool = {
    name: 'list_chats',
    description: 'List publishing destinations (Telegram channels/chats, Facebook Pages or Pinterest boards) of one account. Call it only for an account whose platform in list_accounts is TELEGRAM, FACEBOOK or PINTEREST, and pass that platform exactly as list_accounts returned it; then pass the returned id as telegramChannelId, facebookPageId or pinterestBoardId in schedule_post. Accounts of every other platform, including FACEBOOK_PAGE (an account that is one Facebook Page; connect_account creates these for Facebook), have no destinations: post to them directly via schedule_post.',
    inputSchema: z.object({
        accountId: z.coerce.number().describe('The account ID from list_accounts'),
        platform: z.string().describe('The account\'s platform exactly as list_accounts returned it: TELEGRAM, FACEBOOK or PINTEREST. Never FACEBOOK for a FACEBOOK_PAGE account'),
    }),
};

export async function handleListChats({ accountId, platform }: { accountId: number; platform: string }, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);
    try {
        const response = await client.get(`/v1/accounts/${accountId}/chats?platform=${platform}`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(response.data, null, 2) }] };
    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}
