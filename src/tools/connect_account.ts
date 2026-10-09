import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { createApiClient } from '../api/client';
import { ApiAccount } from '../api/accounts';
import { logger } from '../logger';

/**
 * Platforms a new account can be connected for: those schedule_post can post to.
 * TELEGRAM has no link-based flow and only returns guidance.
 * Tool and prompt descriptions are built from this list, so it is the only place to extend.
 */
export const CONNECTABLE_PLATFORMS = [
    'INSTAGRAM', 'FACEBOOK', 'YOUTUBE', 'TIKTOK', 'THREADS', 'LINKEDIN', 'X_TWITTER', 'BLUE_SKY', 'TELEGRAM', 'PINTEREST',
] as const;

/** Comma-separated CONNECTABLE_PLATFORMS for tool and prompt descriptions. */
export const CONNECTABLE_PLATFORMS_TEXT = CONNECTABLE_PLATFORMS.join(', ');

/** Display names; an account being reconnected may be on a platform outside CONNECTABLE_PLATFORMS. */
const PLATFORM_NAMES: Record<string, string> = {
    INSTAGRAM: 'Instagram',
    FACEBOOK: 'Facebook',
    FACEBOOK_PAGE: 'Facebook',
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
    FACEBOOK_PAGE: 'Facebook: sign in as a Facebook user who manages your Pages, then pick on the PostPulse page which Pages to connect. Each Page becomes its own FACEBOOK_PAGE account (and uses a seat); post to it directly, without list_chats.',
    YOUTUBE: 'YouTube: the Google account must have a YouTube channel.',
    PINTEREST: 'Pinterest: after connecting, call list_chats with platform PINTEREST to pick the board to pin to.',
};

const TELEGRAM_GUIDANCE = `Telegram cannot be connected with a link from the chat. To connect it:
1. Open https://post-pulse.com/app/accounts and sign in with the same login you use for this chat (Google or email).
2. Connect Telegram there.
3. Add the PostPulse bot to the channel or group you want to post to.
4. Come back and tell me, and I will check with list_accounts and list_chats with platform TELEGRAM.`;

const BILLING_URL = 'https://post-pulse.com/app/billing';

/** Issues a single-use PostPulse page link that starts the platform consent when the user clicks Continue. */
const CONNECT_LINKS_PATH = '/v1/accounts/connect-links';

/** Tells PostPulse the link comes from an AI chat, so its page ends with "return to your chat". */
const CONNECT_ORIGIN = 'MCP';

/** How long the server keeps the (not awaited) URL elicitation pending; the tool result does not wait for it. */
const ELICITATION_TIMEOUT_MS = 10 * 60_000;

/** The part of the low-level MCP server the tool needs for the optional URL elicitation. */
export type UrlElicitor = Pick<Server, 'getClientCapabilities' | 'elicitInput'>;

export const connectAccountTool = {
    name: 'connect_account',
    description: 'Get a secure PostPulse link that lets the user connect (or reconnect) a social media account to PostPulse directly from the chat. Show the link to the user; they open it in a browser, check on the PostPulse page which PostPulse account the social account will be attached to, and approve access on the platform. The link is single-use and valid for 24 hours. The tool does not wait: after the user says they are done, call list_accounts to confirm the new account. Use it when list_accounts returns no account for the platform the user wants, or to reconnect an account whose needsReauthorization is true. Pass either platform (new connection) or accountId (reconnect). Telegram is connected on the PostPulse website; for it the tool returns instructions instead of a link.',
    inputSchema: z.object({
        platform: z.enum(CONNECTABLE_PLATFORMS).optional().describe(`Platform to connect: ${CONNECTABLE_PLATFORMS_TEXT}. Not needed when accountId is given.`),
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
    const lines = [
        `[${reconnect ? 'Reconnect' : 'Connect'} ${name}](${url})`,
        url,
        '',
        `This link is tied to your PostPulse account, valid for 24 hours and works once; if it has expired or was already used, ask me for a new one. Do not share it: whoever completes it attaches their ${name} account to your PostPulse account.`,
        `Open it in a browser. The page shows which PostPulse account the ${name} account will be attached to; continue only if it is yours. After approving access on ${name} you will see "Account connected — return to your chat".`,
        'Then tell me, and I will check with list_accounts. If the account does not show up, tell me what the browser page said.',
    ];
    const note = PLATFORM_NOTES[platform];
    if (note) {
        lines.push('', note);
    }
    return lines.join('\n');
}

/**
 * Opens a URL-mode elicitation when the client supports it, without waiting for the answer.
 * Clients time out tool calls after about 60 s, while a client may answer only once the user
 * has finished the whole platform consent (MCP Inspector sends `accept` on "I've completed it"),
 * so awaiting it would fail the tool call. The text result always carries the link anyway.
 * Returns true when the dialog request was sent.
 */
function startUrlElicitation(elicitor: UrlElicitor | undefined, extra: any, platform: string, url: string): boolean {
    if (!elicitor?.getClientCapabilities()?.elicitation?.url) {
        return false;
    }
    elicitor.elicitInput({
        mode: 'url',
        elicitationId: randomUUID(),
        url,
        message: `Open this PostPulse page to connect ${PLATFORM_NAMES[platform] ?? platform} to your PostPulse account.`,
    }, { relatedRequestId: extra?.requestId, timeout: ELICITATION_TIMEOUT_MS })
        .then((result) => logger.info({ tool: 'connect_account', platform, action: result.action }, 'URL elicitation answered'))
        .catch((error: any) => logger.warn({ tool: 'connect_account', platform, err: error?.message }, 'URL elicitation failed'));
    return true;
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
            const response = await client.get<ApiAccount[]>('/v1/accounts');
            const account = response.data.find((acc) => Number(acc.id) === accountId);
            if (!account) {
                log('account_not_found');
                return textResult(`Error: account ${accountId} not found. Call list_accounts to get valid account IDs.`, true);
            }
            if (platform && platform !== account.platform) {
                log('platform_mismatch');
                return textResult(`Error: account ${accountId} is a ${account.platform} account, not ${platform}. Omit platform or pass ${account.platform}.`, true);
            }
            platform = account.platform;
        }

        if (platform === 'TELEGRAM') {
            log('telegram_guidance');
            return textResult(TELEGRAM_GUIDANCE);
        }

        if (!reconnect) {
            const eligibility = (await client.get<{ allowed?: boolean; reason?: string }>('/v1/accounts/can-connect')).data;
            if (!eligibility?.allowed) {
                log('not_allowed');
                return textResult(`Error: a new account cannot be connected right now: ${eligibility?.reason || 'not allowed'}. Check your plan or credits at ${BILLING_URL}.`, true);
            }
        }

        // A new Facebook connection is always one account per Page; a reconnect keeps the account's platform
        if (!reconnect && platform === 'FACEBOOK') {
            platform = 'FACEBOOK_PAGE';
        }

        const body = reconnect
            ? { platform, accountId, origin: CONNECT_ORIGIN }
            : { platform, origin: CONNECT_ORIGIN };
        const url = (await client.post<{ url?: string }>(CONNECT_LINKS_PATH, body)).data?.url;
        if (!url) {
            log('empty_url');
            return textResult('Error: PostPulse did not return a connection link. Try again later.', true);
        }

        const linkText = buildLinkText(platform!, url, reconnect);
        const elicited = startUrlElicitation(elicitor, extra, platform!, url);
        log(elicited ? 'link_issued_elicited' : 'link_issued');
        return textResult(elicited
            ? `Your MCP client also shows this link in a dialog; you can open it from there or use it below.\n\n${linkText}`
            : linkText);
    } catch (error: any) {
        const status = error.response?.status;
        log(`error_${status ?? 'network'}`);
        if (status === 401) {
            return textResult('Error: the PostPulse session has expired. Reconnect the PostPulse MCP server and try again.', true);
        }
        if (error.config?.url === CONNECT_LINKS_PATH) {
            if (status === 400) {
                return textResult(`Error: connecting ${PLATFORM_NAMES[platform!] ?? platform} with a link is not supported. ${apiErrorText(error)}`, true);
            }
            // Seats are checked again when the link is issued; they may have run out since can-connect.
            if (status === 403) {
                const reason = error.response?.data?.error || 'not allowed';
                return textResult(`Error: a new account cannot be connected right now: ${reason}. Check your plan or credits at ${BILLING_URL}.`, true);
            }
            if (status === 429) {
                return textResult('Error: too many connection links were requested. Wait a few minutes and try again.', true);
            }
        }
        return textResult(apiErrorText(error), true);
    }
}
