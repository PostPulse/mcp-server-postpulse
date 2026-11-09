import { z } from 'zod';
import { createApiClient } from '../api/client';
import { ApiAccount, CHAT_PLATFORMS, unknownAccountMessage } from '../api/accounts';

export const listChatsTool = {
    name: 'list_chats',
    description: 'List publishing destinations (Telegram channels/chats, Facebook Pages, Pinterest boards or WhatsApp phone numbers) of one account. Call it only for an account whose platform in list_accounts is TELEGRAM, FACEBOOK, PINTEREST or WHATSAPP; then pass the returned id as telegramChannelId, facebookPageId, pinterestBoardId or whatsappPhoneNumberId (the number to send from) in schedule_post. Accounts of every other platform, including FACEBOOK_PAGE (an account that is one Facebook Page; connect_account creates these for Facebook), have no destinations: post to them directly via schedule_post.',
    inputSchema: z.object({
        accountId: z.coerce.number().int().positive().describe('The account ID from list_accounts'),
    }),
};

export async function handleListChats({ accountId }: { accountId: number }, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);
    try {
        // Check the account first: agents call this with a made-up id (0), an id from an earlier
        // conversation, or a FACEBOOK_PAGE account. Each used to reach the API as a bare 400.
        const accounts = (await client.get<ApiAccount[]>('/v1/accounts')).data;
        const account = accounts.find((acc) => acc.id === accountId);
        if (!account) {
            return { content: [{ type: 'text' as const, text: unknownAccountMessage(accountId, accounts) }], isError: true };
        }
        if (!CHAT_PLATFORMS.includes(account.platform)) {
            return {
                content: [{
                    type: 'text' as const,
                    text: `Account ${accountId} is ${account.platform}: it has no destinations to pick. Call schedule_post with accountId ${accountId} and platform ${account.platform}, without facebookPageId, telegramChannelId or pinterestBoardId.`,
                }],
            };
        }
        const response = await client.get(`/v1/accounts/${accountId}/chats`);
        return { content: [{ type: 'text' as const, text: JSON.stringify(response.data, null, 2) }] };
    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}
