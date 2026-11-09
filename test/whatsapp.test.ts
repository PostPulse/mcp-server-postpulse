import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import {
    handleGetWhatsAppDelivery,
    handleListWhatsAppContactLists,
    handleListWhatsAppTemplates,
    getWhatsAppDeliveryTool,
} from '../src/tools/whatsapp';

const ACCOUNTS = [
    { id: 9, platform: 'WHATSAPP', accountUsername: 'WhatsApp Business account', accountDisplayName: 'Acme' },
    { id: 7, platform: 'TELEGRAM', accountUsername: 'jane_tg' },
];
const TEMPLATES = [{ name: 'autumn_sale', language: 'en', bodyParameterKeys: ['1'], supported: true }];
const LISTS = [{ id: 42, name: 'Newsletter', contactCount: 318 }];
const DELIVERY = { total: 3, delivered: 2, failed: 1, topErrors: [{ code: 131026, title: 'Message undeliverable', count: 1 }] };

let calls: string[] = [];
let failure: { status: number; data: any } | null = null;

(clientModule as any).createApiClient = () => ({
    get: async (url: string) => {
        calls.push(url);
        if (url === '/v1/accounts') return { data: ACCOUNTS };
        if (failure) {
            throw Object.assign(new Error(`Request failed with status code ${failure.status}`), { response: failure });
        }
        if (url === '/v1/accounts/9/whatsapp/templates') return { data: TEMPLATES };
        if (url === '/v1/accounts/9/whatsapp/contact-lists') return { data: LISTS };
        if (url === '/v1/accounts/9/whatsapp/posts/5/delivery') return { data: DELIVERY };
        throw new Error(`unexpected GET ${url}`);
    },
});

const json = (result: any) => JSON.parse(result.content[0].text);

const tests: Array<[string, () => Promise<void>]> = [
    ['list_whatsapp_templates: the account\'s templates as the API returns them', async () => {
        const result: any = await handleListWhatsAppTemplates({ accountId: 9 }, {});
        assert.equal(result.isError, undefined);
        assert.deepEqual(json(result), TEMPLATES);
        assert.deepEqual(calls, ['/v1/accounts', '/v1/accounts/9/whatsapp/templates']);
    }],
    ['list_whatsapp_contact_lists: the account\'s lists', async () => {
        const result: any = await handleListWhatsAppContactLists({ accountId: 9 }, {});
        assert.deepEqual(json(result), LISTS);
    }],
    ['get_whatsapp_delivery: the summary of the post', async () => {
        const result: any = await handleGetWhatsAppDelivery({ accountId: 9, postId: 5 }, {});
        assert.deepEqual(json(result), DELIVERY);
        assert.deepEqual(calls, ['/v1/accounts', '/v1/accounts/9/whatsapp/posts/5/delivery']);
    }],
    ['an account that is not WhatsApp: error, no WhatsApp call', async () => {
        const result: any = await handleListWhatsAppTemplates({ accountId: 7 }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /account 7 is TELEGRAM, not a WHATSAPP account/);
        assert.deepEqual(calls, ['/v1/accounts']);
    }],
    ['an unknown account lists the current ones', async () => {
        const result: any = await handleListWhatsAppContactLists({ accountId: 2127 }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /account 2127 is not one of the user's connected accounts/);
        assert.match(result.content[0].text, /9 \(WHATSAPP @WhatsApp Business account\)/);
    }],
    ['an API error comes back with its body', async () => {
        failure = { status: 400, data: { error: 'No post 5 found for WhatsApp account 9' } };
        const result: any = await handleGetWhatsAppDelivery({ accountId: 9, postId: 5 }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /status code 400/);
        assert.match(result.content[0].text, /No post 5 found/);
    }],
    ['postId and accountId must be positive', async () => {
        assert.equal(getWhatsAppDeliveryTool.inputSchema.safeParse({ accountId: 9, postId: 0 }).success, false);
        assert.equal(getWhatsAppDeliveryTool.inputSchema.safeParse({ accountId: 0, postId: 5 }).success, false);
    }],
];

(async () => {
    let failed = 0;
    for (const [name, run] of tests) {
        calls = [];
        failure = null;
        try {
            await run();
            console.log(`ok   ${name}`);
        } catch (err) {
            failed++;
            console.error(`FAIL ${name}`, err);
        }
    }
    console.log(`${tests.length - failed}/${tests.length} WhatsApp tool tests passed`);
    process.exit(failed ? 1 : 0);
})();
