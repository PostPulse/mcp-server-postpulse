import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import { handleListAccounts } from '../src/tools/list_accounts';
import { handleListAccountsResource } from '../src/resources/accounts';

let accounts: any[] = [];

(clientModule as any).createApiClient = () => ({
    get: async (url: string) => {
        if (url === '/v1/accounts') return { data: accounts };
        throw new Error(`unexpected GET ${url}`);
    },
});

const tests: Array<[string, () => Promise<void>]> = [
    ['empty list: JSON first, then the connect_account hint', async () => {
        accounts = [];
        const result: any = await handleListAccounts({}, {});
        assert.equal(result.content.length, 2);
        assert.deepEqual(JSON.parse(result.content[0].text), []);
        assert.match(result.content[1].text, /connect_account/);
    }],
    ['fields: display name and needsReauthorization are passed through', async () => {
        accounts = [
            { id: 1, platform: 'LINKEDIN', accountUsername: 'jane', accountDisplayName: 'Jane Doe', needsReauthorization: false },
        ];
        const result: any = await handleListAccounts({}, {});
        assert.equal(result.content.length, 1);
        assert.deepEqual(JSON.parse(result.content[0].text), [
            { id: 1, platform: 'LINKEDIN', username: 'jane', name: 'Jane Doe', needsReauthorization: false },
        ]);
    }],
    ['needsReauthorization: hint names the account and connect_account(accountId)', async () => {
        accounts = [
            { id: 1, platform: 'LINKEDIN', accountUsername: 'jane', accountDisplayName: 'Jane', needsReauthorization: false },
            { id: 2, platform: 'X_TWITTER', accountUsername: 'jane_x', accountDisplayName: 'Jane X', needsReauthorization: true },
        ];
        const result: any = await handleListAccounts({}, {});
        assert.equal(result.content.length, 2);
        assert.match(result.content[1].text, /2 \(X_TWITTER @jane_x\)/);
        assert.doesNotMatch(result.content[1].text, /1 \(LINKEDIN/);
        assert.match(result.content[1].text, /connect_account with their accountId/);
    }],
    ['resource: same mapping, including needsReauthorization', async () => {
        accounts = [
            { id: 2, platform: 'X_TWITTER', accountUsername: 'jane_x', accountDisplayName: 'Jane X', needsReauthorization: true },
        ];
        const result = await handleListAccountsResource(new URL('postpulse://accounts'), {});
        assert.deepEqual(JSON.parse(result.contents[0].text), [
            { id: 2, platform: 'X_TWITTER', username: 'jane_x', name: 'Jane X', needsReauthorization: true },
        ]);
    }],
];

async function run() {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`✅ ${name}`);
        } catch (error: any) {
            failed++;
            console.error(`❌ ${name}\n   ${error.message}`);
        }
    }
    console.log(`\n${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
}

run();
