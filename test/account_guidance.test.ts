import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import { handleListChats, listChatsTool } from '../src/tools/list_chats';
import { handleSchedulePost, schedulePostTool } from '../src/tools/schedule_post';

let accounts: any[] = [];
let calls: string[] = [];

(clientModule as any).createApiClient = () => ({
    get: async (url: string) => {
        calls.push(`GET ${url}`);
        if (url === '/v1/accounts') return { data: accounts };
        if (url === '/v1/accounts/7/chats') return { data: [{ id: '123', name: 'My Page' }] };
        if (url === '/v1/accounts/9/chats') return { data: [{ id: '1065', title: 'Acme +44 7700 900123', type: 'PHONE_NUMBER' }] };
        throw new Error(`unexpected GET ${url}`);
    },
    post: async (url: string) => {
        calls.push(`POST ${url}`);
        return { data: { id: 99 } };
    },
});

const ACCOUNTS = [
    { id: 7, platform: 'FACEBOOK', accountUsername: 'jane' },
    { id: 8, platform: 'FACEBOOK_PAGE', accountUsername: 'jane_page' },
];

const tests: Array<[string, () => Promise<void>]> = [
    ['accountId 0 is rejected by the input schema', async () => {
        assert.equal(listChatsTool.inputSchema.safeParse({ accountId: 0 }).success, false);
        assert.equal(schedulePostTool.inputSchema.safeParse({ accountId: 0, platform: 'X', scheduledTime: 'x' }).success, false);
    }],
    ['list_chats: unknown account lists the current ones, no chats call', async () => {
        accounts = ACCOUNTS; calls = [];
        const result: any = await handleListChats({ accountId: 2129 }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /account 2129 is not one of the user's connected accounts/);
        assert.match(result.content[0].text, /7 \(FACEBOOK @jane\), 8 \(FACEBOOK_PAGE @jane_page\)/);
        assert.deepEqual(calls, ['GET /v1/accounts']);
    }],
    ['list_chats: FACEBOOK_PAGE gets guidance, not an error, and no chats call', async () => {
        accounts = ACCOUNTS; calls = [];
        const result: any = await handleListChats({ accountId: 8 }, {});
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Account 8 is FACEBOOK_PAGE: it has no destinations/);
        assert.match(result.content[0].text, /schedule_post with accountId 8 and platform FACEBOOK_PAGE/);
        assert.deepEqual(calls, ['GET /v1/accounts']);
    }],
    ['list_chats: FACEBOOK account still lists its Pages', async () => {
        accounts = ACCOUNTS; calls = [];
        const result: any = await handleListChats({ accountId: 7 }, {});
        assert.equal(result.isError, undefined);
        assert.deepEqual(JSON.parse(result.content[0].text), [{ id: '123', name: 'My Page' }]);
        assert.deepEqual(calls, ['GET /v1/accounts', 'GET /v1/accounts/7/chats']);
    }],
    ['list_chats: WHATSAPP account lists its phone numbers', async () => {
        accounts = [...ACCOUNTS, { id: 9, platform: 'WHATSAPP', accountUsername: 'WhatsApp Business account' }]; calls = [];
        const result: any = await handleListChats({ accountId: 9 }, {});
        assert.equal(result.isError, undefined);
        assert.equal(JSON.parse(result.content[0].text)[0].type, 'PHONE_NUMBER');
        assert.deepEqual(calls, ['GET /v1/accounts', 'GET /v1/accounts/9/chats']);
    }],
    ['schedule_post: unknown account is answered without posting', async () => {
        accounts = ACCOUNTS; calls = [];
        const result: any = await handleSchedulePost(
            { accountId: 2154, platform: 'FACEBOOK_PAGE', content: 'hi', scheduledTime: '2026-11-05T10:00:00Z' }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /account 2154 is not one of the user's connected accounts/);
        assert.deepEqual(calls, ['GET /v1/accounts']);
    }],
    ['schedule_post: known account posts as before', async () => {
        accounts = ACCOUNTS; calls = [];
        const result: any = await handleSchedulePost(
            { accountId: 8, platform: 'FACEBOOK_PAGE', content: 'hi', scheduledTime: '2026-11-05T10:00:00Z' }, {});
        assert.match(result.content[0].text, /Post scheduled successfully \(ID: 99\)/);
        assert.deepEqual(calls, ['GET /v1/accounts', 'POST /v1/posts']);
    }],
    ['no accounts at all points to connect_account', async () => {
        accounts = []; calls = [];
        const result: any = await handleListChats({ accountId: 5 }, {});
        assert.match(result.content[0].text, /no connected accounts: use connect_account first/);
    }],
];

async function run() {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`ok - ${name}`);
        } catch (error) {
            failed++;
            console.error(`not ok - ${name}`);
            console.error(error);
        }
    }
    if (failed > 0) {
        process.exit(1);
    }
}

run();
