import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createApiClient } from '../api/client';
import { logger } from '../logger';

/**
 * Platforms a new account can be connected for. Values are the backend `Platform` enum names.
 * PINTEREST is left out until schedule_post can post to it; REDDIT and GOOGLE_BUSINESS are added
 * by their own plans. TELEGRAM has no link-based flow and only returns guidance.
 */
export const CONNECTABLE_PLATFORMS = [
    'INSTAGRAM', 'FACEBOOK', 'YOUTUBE', 'TIKTOK', 'THREADS', 'LINKEDIN', 'X_TWITTER', 'BLUE_SKY', 'TELEGRAM',
] as const;

const PLATFORM_NAMES: Record<string, string> = {
    INSTAGRAM: 'Instagram',
    FACEBOOK: 'Facebook',
    YOUTUBE: 'YouTube',
    TIKTOK: 'TikTok',
    THREADS: 'Threads',
    LINKEDIN: 'LinkedIn',
    X_TWITTER: 'X (Twitter)',
    BLUE_SKY: 'Bluesky',
    TELEGRAM: 'Telegram',
    PINTEREST: 'Pinterest',
};

const PLATFORM_NOTES: Record<string, string> = {
    INSTAGRAM: 'Instagram: the account must be a Business or Creator account.',
    FACEBOOK: 'Facebook: sign in as a Facebook user who manages the Page you want to post to. After connecting, call list_chats with platform FACEBOOK to pick the Page.',
    YOUTUBE: 'YouTube: the Google account must have a YouTube channel.',
    TIKTOK: 'TikTok: the account must allow posting from third-party apps.',
};

const TELEGRAM_GUIDANCE = `Telegram cannot be connected with a link from the chat. To connect it:
1. Open https://post-pulse.com/app/accounts and sign in with the same login you use for this chat (Google or email).
2. Connect Telegram there.
3. Add the PostPulse bot to the channel or group you want to post to.
4. Come back and tell me, and I will check with list_accounts.`;

const BILLING_URL = 'https://post-pulse.com/app/billing';

/** Reason returned by `GET /v1/accounts/can-connect` before the signup bonus credits land. */
const NO_SUBSCRIPTION_REASON = 'No active subscription found';
const SIGNUP_BONUS_RETRY_MS = 2000;
const ELICITATION_TIMEOUT_MS = 120_000;

/** Indirection so tests can stub the retry delay. */
export const connectAccountDeps = {
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/** The part of the low-level MCP server the tool needs for the optional URL elicitation. */
export type UrlElicitor = Pick<Server, 'getClientCapabilities' | 'elicitInput'>;

export const connectAccountTool = {
    name: 'connect_account',
    description: 'Get a secure link that lets the user connect (or reconnect) a social media account to PostPulse directly from the chat. Show the link to the user; they open it in a browser and approve access on the platform. The tool does not wait: after the user says they are done, call list_accounts to confirm the new account. Use it when list_accounts returns no account for the platform the user wants, or to reconnect an account whose needsReauthorization is true. Pass either platform (new connection) or accountId (reconnect). Telegram is connected on the PostPulse website; for it the tool returns instructions instead of a link.',
    inputSchema: z.object({
        platform: z.enum(CONNECTABLE_PLATFORMS).optional().describe('Platform to connect: INSTAGRAM, FACEBOOK, YOUTUBE, TIKTOK, THREADS, LINKEDIN, X_TWITTER, BLUE_SKY or TELEGRAM. Not needed when accountId is given.'),
        accountId: z.coerce.number().optional().describe('Only to reconnect an existing account whose needsReauthorization is true (from list_accounts). The platform is taken from the account.'),
    }),
};

function textResult(text: string, isError = false) {
    return {
        content: [{ type: 'text' as const, text }],
        ...(isError ? { isError: true } : {}),
    };
}

function apiErrorText(error: any): string {
    return `Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}`;
}

function buildLinkText(platform: string, url: string, reconnect: boolean): string {
    const name = PLATFORM_NAMES[platform] ?? platform;
    const lifetime = platform === 'BLUE_SKY'
        ? 'valid for about 5 minutes; if it has expired, ask me for a new one'
        : 'valid for 2 hours';
    const lines = [
        `[${reconnect ? 'Reconnect' : 'Connect'} ${name}](${url})`,
        url,
        '',
        `This link is single-use, tied to your PostPulse account and ${lifetime}. Do not share it: whoever completes it attaches their ${name} account to your PostPulse account.`,
        `Open it in a browser and approve access on ${name}. You will then see "Account connected". If the browser opens the PostPulse app instead, the account is connected too; just close the tab.`,
        'Then tell me, and I will check with list_accounts. If the account does not show up, tell me what the browser page said.',
    ];
    const note = PLATFORM_NOTES[platform];
    if (note) {
        lines.push('', note);
    }
    return lines.join('\n');
}

/**
 * Opens a URL-mode elicitation when the client supports it. Returns a line to put in front of
 * the tool result, or null when elicitation is unavailable or failed (text-only fallback).
 */
async function tryUrlElicitation(elicitor: UrlElicitor | undefined, extra: any, platform: string, url: string) {
    if (!elicitor?.getClientCapabilities()?.elicitation?.url) {
        return null;
    }
    try {
        const result = await elicitor.elicitInput({
            mode: 'url',
            elicitationId: randomUUID(),
            url,
            message: `Open this link to connect ${PLATFORM_NAMES[platform] ?? platform} to your PostPulse account.`,
        }, { relatedRequestId: extra?.requestId, timeout: ELICITATION_TIMEOUT_MS });
        return result.action === 'accept'
            ? 'The user accepted opening the link in the browser.'
            : 'The user declined to open the link from the dialog; they can still use the link below.';
    } catch (error: any) {
        logger.warn({ tool: 'connect_account', err: error?.message }, 'URL elicitation failed, falling back to text');
        return null;
    }
}

export async function handleConnectAccount(
    args: { platform?: string; accountId?: number },
    extra: any,
    elicitor?: UrlElicitor,
) {
    // Some clients send null for omitted optional fields, which z.coerce turns into 0; account IDs are positive.
    const accountId = args.accountId && args.accountId > 0 ? args.accountId : undefined;
    let platform = args.platform;
    const reconnect = accountId !== undefined;
    const log = (outcome: string) =>
        logger.info({ tool: 'connect_account', platform, reconnect, outcome }, 'connect_account finished');

    if (!platform && !reconnect) {
        log('invalid_input');
        return textResult('Error: pass either platform (to connect a new account) or accountId (to reconnect an existing one).', true);
    }

    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);

    try {
        if (reconnect) {
            const response = await client.get('/v1/accounts');
            const account = (response.data as any[]).find((acc) => Number(acc.id) === accountId);
            if (!account) {
                log('account_not_found');
                return textResult(`Error: account ${accountId} not found. Call list_accounts to get valid account IDs.`, true);
            }
            if (platform && platform !== account.platform) {
                log('platform_mismatch');
                return textResult(`Error: account ${accountId} is a ${account.platform} account, not ${platform}. Omit platform or pass ${account.platform}.`, true);
            }
            platform = account.platform as string;
        }

        if (platform === 'TELEGRAM') {
            log('telegram_guidance');
            return textResult(TELEGRAM_GUIDANCE);
        }

        if (!reconnect) {
            let eligibility = (await client.get('/v1/accounts/can-connect')).data;
            if (!eligibility?.allowed && eligibility?.reason === NO_SUBSCRIPTION_REASON) {
                // A brand-new user gets the signup bonus credits asynchronously; give it one more chance.
                await connectAccountDeps.sleep(SIGNUP_BONUS_RETRY_MS);
                eligibility = (await client.get('/v1/accounts/can-connect')).data;
            }
            if (!eligibility?.allowed) {
                log('not_allowed');
                return textResult(`Error: a new account cannot be connected right now: ${eligibility?.reason || 'not allowed'}. Check your plan or credits at ${BILLING_URL}.`, true);
            }
        }

        const body = reconnect ? { platform, accountId } : { platform };
        const url: string | undefined = (await client.post('/v1/accounts/oauth/authorize-url', body)).data?.url;
        if (!url) {
            log('empty_url');
            return textResult('Error: PostPulse did not return a connection link. Try again later.', true);
        }

        const linkText = buildLinkText(platform!, url, reconnect);
        const elicitationLine = await tryUrlElicitation(elicitor, extra, platform!, url);
        log(elicitationLine ? 'link_issued_elicited' : 'link_issued');
        return textResult(elicitationLine ? `${elicitationLine}\n\n${linkText}` : linkText);
    } catch (error: any) {
        const status = error.response?.status;
        log(`error_${status ?? 'network'}`);
        if (status === 401) {
            return textResult('Error: the PostPulse session has expired. Reconnect the PostPulse MCP server and try again.', true);
        }
        if (status === 400 && error.config?.url === '/v1/accounts/oauth/authorize-url') {
            return textResult(`Error: connecting ${PLATFORM_NAMES[platform!] ?? platform} with a link is not supported. ${apiErrorText(error)}`, true);
        }
        return textResult(apiErrorText(error), true);
    }
}
