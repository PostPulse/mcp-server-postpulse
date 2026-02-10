import { z } from 'zod';
import { createApiClient } from '../api/client';

export const listAccountsTool = {
    name: 'list_accounts',
    description: 'List all connected social media accounts (Instagram, Facebook, Telegram, etc.) with their IDs and platforms.',
    inputSchema: z.object({}),
};

export async function handleListAccounts(_args: any, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const client = createApiClient(token);
    try {
        const response = await client.get('/v1/accounts');
        const accounts = response.data.map((acc: any) => ({
            id: acc.id,
            platform: acc.platform,
            username: acc.accountUsername,
            name: acc.accountName,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify(accounts, null, 2) }] };
    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}
