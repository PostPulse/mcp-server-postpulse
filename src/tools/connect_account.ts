import { z } from 'zod';
import { jsonResult, toolContext, URLS } from './shared';

// TELEGRAM is intentionally absent: it connects via a bot flow in the PostPulse app,
// not the standard OAuth flow this tool drives.
const OAUTH_PLATFORMS = [
    'INSTAGRAM',
    'FACEBOOK',
    'YOUTUBE',
    'TIKTOK',
    'THREADS',
    'LINKEDIN',
    'X_TWITTER',
    'BLUE_SKY',
] as const;

export const connectAccountTool = {
    name: 'connect_account',
    description: 'Get a URL the user must open in a browser to connect (or reconnect) a social media account to PostPulse. Use this when list_accounts shows no accounts, when the user asks to add a platform, or when an account has needsReauthorization=true (pass its accountId to reconnect). The returned link is single-use and expires in about 10 minutes — show it to the user, ask them to open it and approve access, then call list_accounts to confirm. Supports Instagram, Facebook, YouTube, TikTok, Threads, LinkedIn, X/Twitter, and Bluesky. Telegram is the one exception: it must be connected inside the PostPulse app at https://post-pulse.com/app/accounts.',
    inputSchema: z.object({
        platform: z.enum(OAUTH_PLATFORMS).describe('Platform to connect (e.g. INSTAGRAM). Telegram is not supported here — send the user to https://post-pulse.com/app/accounts instead.'),
        accountId: z.coerce.number().optional().describe('Only to reconnect an existing account (e.g. needsReauthorization=true in list_accounts): the account ID to reauthorize. Omit when connecting a new account.'),
    }),
};

export async function handleConnectAccount({ platform, accountId }: { platform: string; accountId?: number }, extra: any) {
    const ctx = toolContext('connect_account', extra);
    try {
        const response = await ctx.client.post('/v1/accounts/oauth/authorize-url', {
            platform,
            ...(accountId !== undefined ? { accountId } : {}),
        });
        ctx.ok({ platform, reconnect: accountId !== undefined });
        return jsonResult({
            connectUrl: response.data.url,
            platform,
            expiresInMinutes: 10,
            nextSteps: 'Show connectUrl to the user as a clickable link and ask them to open it in a browser and approve access. The link is single-use and expires in about 10 minutes (call connect_account again if it expires). When they are done they will see an "Account connected" confirmation page — then call list_accounts to verify the account appears.',
        });
    } catch (error: any) {
        return ctx.fail(error, { platform });
    }
}

export { OAUTH_PLATFORMS };
export const TELEGRAM_CONNECT_HINT = `Telegram cannot be connected via connect_account — the user must connect it in the PostPulse app at ${URLS.accountsPage}.`;
