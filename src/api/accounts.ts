/** An account item as returned by `GET /v1/accounts` (only the fields this server reads). */
export interface ApiAccount {
    id: number;
    platform: string;
    accountUsername?: string;
    accountDisplayName?: string;
    needsReauthorization?: boolean;
}

/** Compact view of a social media account, shared by the list_accounts tool and the accounts resource. */
export interface AccountSummary {
    id: number;
    platform: string;
    username?: string;
    name?: string;
    needsReauthorization: boolean;
}

export function toAccountSummary(acc: ApiAccount): AccountSummary {
    return {
        id: acc.id,
        platform: acc.platform,
        username: acc.accountUsername,
        name: acc.accountDisplayName,
        needsReauthorization: Boolean(acc.needsReauthorization),
    };
}

/** Platforms whose accounts publish to a destination picked with list_chats (Page, channel/chat, board). */
export const CHAT_PLATFORMS = ['FACEBOOK', 'TELEGRAM', 'PINTEREST'];

/**
 * Error text for an accountId that is not one of the user's accounts: an id the agent made up (0),
 * remembered from an earlier conversation, or of an account that was disconnected. Lists the
 * current accounts so the agent can retry without another call.
 */
export function unknownAccountMessage(accountId: number, accounts: ApiAccount[]): string {
    const current = accounts.length === 0
        ? 'The user has no connected accounts: use connect_account first.'
        : `Current accounts: ${accounts.map((acc) => `${acc.id} (${acc.platform}${acc.accountUsername ? ` @${acc.accountUsername}` : ''})`).join(', ')}.`;
    return `Error: account ${accountId} is not one of the user's connected accounts (it may have been disconnected, or the id is from an earlier list_accounts). Use an id from list_accounts. ${current}`;
}
