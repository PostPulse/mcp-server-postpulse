import { z } from 'zod';
import { createApiClient } from '../api/client';

export const listAccountsTool = {
    name: 'list_accounts',
    description: 'List all connected social media accounts (Instagram, Facebook, YouTube, TikTok, Threads, LinkedIn, X/Twitter, Telegram) with their IDs, platforms, usernames, and display names. Call this first to discover available accounts before using schedule_post or list_chats.',
    inputSchema: z.object({}),
};

export async function handleListAccounts(_args: any, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);
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
