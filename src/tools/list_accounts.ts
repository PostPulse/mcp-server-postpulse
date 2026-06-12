import { z } from 'zod';
import { jsonResult, toolContext } from './shared';
import { TELEGRAM_CONNECT_HINT } from './connect_account';

export const listAccountsTool = {
    name: 'list_accounts',
    description: 'List all connected social media accounts (Instagram, Facebook, YouTube, TikTok, Threads, LinkedIn, X/Twitter, Telegram, Bluesky) with their IDs, platforms, usernames, and display names. Call this first to discover available accounts before using schedule_post or list_chats. If it returns no accounts, use connect_account to get a connect URL for the user.',
    inputSchema: z.object({}),
};

export async function handleListAccounts(_args: any, extra: any) {
    const ctx = toolContext('list_accounts', extra);
    try {
        const response = await ctx.client.get('/v1/accounts');
        const accounts = response.data.map((acc: any) => ({
            id: acc.id,
            platform: acc.platform,
            username: acc.accountUsername,
            name: acc.accountName,
            needsReauthorization: acc.needsReauthorization === true,
        }));

        if (accounts.length === 0) {
            ctx.ok({ accounts: 0, zeroAccounts: true });
            return jsonResult({
                connectedSocialAccounts: [],
                status: 'NO_SOCIAL_ACCOUNTS_CONNECTED',
                whatThisMeans: 'The user\'s PostPulse account is active, but no social media account is connected yet, so there is nowhere to publish to.',
                howToFix: 'Ask the user which platform they want to post on, then call connect_account with that platform. Show the returned URL to the user, ask them to open it and approve access, and call list_accounts again to confirm. '
                    + TELEGRAM_CONNECT_HINT,
            });
        }

        ctx.ok({ accounts: accounts.length });
        return jsonResult(accounts);
    } catch (error: any) {
        return ctx.fail(error);
    }
}
