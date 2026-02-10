import { z } from 'zod';
import { createApiClient } from '../api/client';

export const listChatsTool = {
    name: 'list_chats',
    description: 'List chat threads for a connected social media account.',
    inputSchema: z.object({
        accountId: z.coerce.number().describe('The account ID from list_accounts'),
        platform: z.string().describe('Platform name (e.g. INSTAGRAM, FACEBOOK, TELEGRAM)'),
    }),
};

export async function handleListChats({ accountId, platform }: { accountId: number; platform: string }, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const client = createApiClient(token);
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
