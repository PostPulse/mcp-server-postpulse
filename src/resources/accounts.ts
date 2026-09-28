import { createApiClient } from '../api/client';
import { toAccountSummary } from '../api/accounts';

export const listAccountsResource = {
    uri: 'postpulse://accounts',
    name: 'Social Media Accounts',
    description: 'A list of all connected social media accounts (Instagram, Facebook, Telegram, etc.) with id, platform, username, name and needsReauthorization (true means the account must be reconnected with connect_account before posting). Empty for a new user.',
};

export async function handleListAccountsResource(_uri: URL, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);

    try {
        const response = await client.get('/v1/accounts');
        const accounts = response.data.map(toAccountSummary);

        return {
            contents: [{
                uri: _uri.href,
                mimeType: 'application/json',
                text: JSON.stringify(accounts, null, 2)
            }]
        };
    } catch (error: any) {
        throw new Error(`Failed to fetch accounts: ${error.message}`);
    }
}
