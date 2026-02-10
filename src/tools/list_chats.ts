import { createApiClient } from '../api/client';

export const listChatsTool = {
    name: 'list_chats',
    description: 'List chat threads for a connected social media account.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            accountId: { type: 'number', description: 'The account ID from list_accounts' },
            platform: { type: 'string', description: 'Platform name (e.g. INSTAGRAM, FACEBOOK, TELEGRAM)' },
        },
        required: ['accountId', 'platform'],
    },
};

export async function handleListChats({ accountId, platform }: any, extra: any) {
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
