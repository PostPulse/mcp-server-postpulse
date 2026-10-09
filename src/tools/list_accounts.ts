import { z } from 'zod';
import { createApiClient } from '../api/client';
import { ApiAccount, toAccountSummary } from '../api/accounts';

export const listAccountsTool = {
    name: 'list_accounts',
    description: 'List all connected social media accounts (Instagram, Facebook, Facebook Page, YouTube, TikTok, Threads, LinkedIn, X/Twitter, Bluesky, Telegram) with their IDs, platforms, usernames, display names and needsReauthorization flag. Call this first to discover available accounts before using schedule_post or list_chats. A new user may have no accounts yet: in that case, or when the wanted platform is missing, use connect_account. An account with needsReauthorization true must be reconnected with connect_account(accountId) before posting.',
    inputSchema: z.object({}),
};

export async function handleListAccounts(_args: any, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);
    try {
        const response = await client.get<ApiAccount[]>('/v1/accounts');
        const accounts = response.data.map(toAccountSummary);
        const content = [{ type: 'text' as const, text: JSON.stringify(accounts, null, 2) }];

        if (accounts.length === 0) {
            content.push({ type: 'text' as const, text: 'No social accounts are connected yet. Use connect_account to connect one.' });
        }
        const stale = accounts.filter((acc) => acc.needsReauthorization);
        if (stale.length > 0) {
            const names = stale.map((acc) => `${acc.id} (${acc.platform}${acc.username ? ` @${acc.username}` : ''})`).join(', ');
            content.push({ type: 'text' as const, text: `These accounts need reauthorization before posting: ${names}. Use connect_account with their accountId to reconnect them.` });
        }
        return { content };
    } catch (error: any) {
        return {
            content: [{ type: 'text' as const, text: `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}` }],
            isError: true,
        };
    }
}
