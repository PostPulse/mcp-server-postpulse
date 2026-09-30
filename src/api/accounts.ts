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
