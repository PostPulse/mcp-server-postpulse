import { createApiClient } from '../api/client';

export const listAccountsResource = {
    uri: 'postpulse://accounts',
    name: 'Social Media Accounts',
    description: 'A list of all connected social media accounts (Instagram, Facebook, Telegram, etc.)',
};

export async function handleListAccountsResource(_uri: URL, extra: any) {
    const token = (extra as any)?.authInfo?.token || '';
    const client = createApiClient(token);

    try {
        const response = await client.get('/v1/accounts');
        const accounts = response.data.map((acc: any) => ({
            id: acc.id,
            platform: acc.platform,
            username: acc.accountUsername,
            name: acc.accountName,
        }));

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
