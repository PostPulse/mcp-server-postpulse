/**
 * Compact view of a PostPulse social media account (`GET /v1/accounts` returns
 * `SocialMediaAccountDto`), shared by the list_accounts tool and the accounts resource.
 */
export interface AccountSummary {
    id: number;
    platform: string;
    username?: string;
    name?: string;
    needsReauthorization: boolean;
}

export function toAccountSummary(acc: any): AccountSummary {
    return {
        id: acc.id,
        platform: acc.platform,
        username: acc.accountUsername,
        name: acc.accountDisplayName,
        needsReauthorization: Boolean(acc.needsReauthorization),
    };
}
