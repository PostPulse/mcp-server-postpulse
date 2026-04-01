import { z } from 'zod';
import { createApiClient } from '../api/client';

export const listChatsTool = {
    name: 'list_chats',
    description: 'List publishing destinations (Telegram channels/chats or Facebook Pages) available for a specific account. Required before scheduling posts to Telegram or Facebook — use the returned id as the chatId parameter in schedule_post. Only supports TELEGRAM and FACEBOOK platforms; other platforms do not have sub-destinations and should be posted to directly via schedule_post.',
    inputSchema: z.object({
        accountId: z.coerce.number().describe('The account ID from list_accounts'),
        platform: z.string().describe('Platform name: FACEBOOK or TELEGRAM (only these two platforms have sub-destinations)'),
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
