import { z } from 'zod';
import { jsonResult, toolContext } from './shared';

export const listChatsTool = {
    name: 'list_chats',
    description: 'List publishing destinations (Telegram channels/chats or Facebook Pages) available for a specific account. Required before scheduling posts to Telegram or Facebook — use the returned id as the chatId parameter in schedule_post. Only supports TELEGRAM and FACEBOOK platforms; other platforms do not have sub-destinations and should be posted to directly via schedule_post.',
    inputSchema: z.object({
        accountId: z.coerce.number().describe('The account ID from list_accounts'),
        platform: z.string().describe('Platform name: FACEBOOK or TELEGRAM (only these two platforms have sub-destinations)'),
    }),
};

export async function handleListChats({ accountId, platform }: { accountId: number; platform: string }, extra: any) {
    const ctx = toolContext('list_chats', extra);
    try {
        const response = await ctx.client.get(`/v1/accounts/${accountId}/chats?platform=${platform}`);
        ctx.ok({ platform, chats: Array.isArray(response.data) ? response.data.length : undefined });
        return jsonResult(response.data);
    } catch (error: any) {
        return ctx.fail(error, { platform });
    }
}
