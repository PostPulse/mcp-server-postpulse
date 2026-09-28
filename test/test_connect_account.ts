import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import { handleConnectAccount, connectAccountDeps, UrlElicitor } from '../src/tools/connect_account';

// ─── Manual mock of the API client ──────────────────────────────────────────

const CONSENT_URL = 'https://www.linkedin.com/oauth/v2/authorization?state=secret-state';

interface Call { method: 'GET' | 'POST'; url: string; body?: any }

let calls: Call[] = [];
let getHandler: (url: string) => any = () => { throw new Error('unexpected GET'); };
let postHandler: (url: string, body: any) => any = () => ({ data: { url: CONSENT_URL } });

(clientModule as any).createApiClient = () => ({
    get: async (url: string) => {
        calls.push({ method: 'GET', url });
        return getHandler(url);
    },
    post: async (url: string, body: any) => {
        calls.push({ method: 'POST', url, body });
        return postHandler(url, body);
    },
});

let sleeps: number[] = [];
connectAccountDeps.sleep = async (ms: number) => { sleeps.push(ms); };

const ACCOUNTS = [
    { id: 7, platform: 'LINKEDIN', accountUsername: 'jane', accountDisplayName: 'Jane', needsReauthorization: true },
    { id: 8, platform: 'TELEGRAM', accountUsername: 'jane_tg', accountDisplayName: 'Jane TG', needsReauthorization: false },
];

function httpError(status: number, url: string, data: any) {
    return Object.assign(new Error(`Request failed with status code ${status}`), {
        response: { status, data },
        config: { url },
    });
}

function reset() {
    calls = [];
    sleeps = [];
    getHandler = (url) => {
        if (url === '/v1/accounts/can-connect') return { data: { allowed: true } };
        if (url === '/v1/accounts') return { data: ACCOUNTS };
        throw new Error(`unexpected GET ${url}`);
    };
    postHandler = () => ({ data: { url: CONSENT_URL } });
}

const text = (result: any) => result.content.map((c: any) => c.text).join('\n');
const authorizeCalls = () => calls.filter((c) => c.url === '/v1/accounts/oauth/authorize-url');

// ─── Tests ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
    ['new connection: can-connect, then authorize-url with {platform}', async () => {
        const result = await handleConnectAccount({ platform: 'LINKEDIN' }, {});
        assert.equal(result.isError, undefined);
        assert.deepEqual(calls.map((c) => c.url), ['/v1/accounts/can-connect', '/v1/accounts/oauth/authorize-url']);
        assert.deepEqual(authorizeCalls()[0].body, { platform: 'LINKEDIN' });
        assert.match(text(result), /\[Connect LinkedIn\]\(https:\/\/www\.linkedin\.com/);
        assert.ok(text(result).includes(CONSENT_URL));
        assert.match(text(result), /2 hours/);
        assert.match(text(result), /Do not share it/);
    }],
    ['Bluesky: 5-minute lifetime wording', async () => {
        const result = await handleConnectAccount({ platform: 'BLUE_SKY' }, {});
        assert.match(text(result), /about 5 minutes/);
        assert.doesNotMatch(text(result), /2 hours/);
    }],
    ['platform notes: Facebook points to list_chats', async () => {
        const result = await handleConnectAccount({ platform: 'FACEBOOK' }, {});
        assert.match(text(result), /list_chats with platform FACEBOOK/);
    }],
    ['can-connect false (seat limit): error with billing link, no authorize-url', async () => {
        getHandler = () => ({ data: { allowed: false, reason: 'You have reached the maximum number of accounts allowed by your subscription.' } });
        const result = await handleConnectAccount({ platform: 'INSTAGRAM' }, {});
        assert.equal(result.isError, true);
        assert.match(text(result), /maximum number of accounts/);
        assert.match(text(result), /post-pulse\.com\/app\/billing/);
        assert.equal(authorizeCalls().length, 0);
        assert.deepEqual(sleeps, []);
    }],
    ['can-connect "No active subscription found", then true on retry: success', async () => {
        let n = 0;
        getHandler = () => (++n === 1
            ? { data: { allowed: false, reason: 'No active subscription found' } }
            : { data: { allowed: true } });
        const result = await handleConnectAccount({ platform: 'TIKTOK' }, {});
        assert.equal(result.isError, undefined);
        assert.deepEqual(sleeps, [2000]);
        assert.equal(calls.filter((c) => c.url === '/v1/accounts/can-connect').length, 2);
        assert.equal(authorizeCalls().length, 1);
        assert.match(text(result), /third-party apps/);
    }],
    ['can-connect "No active subscription found" twice: error after one retry', async () => {
        getHandler = () => ({ data: { allowed: false, reason: 'No active subscription found' } });
        const result = await handleConnectAccount({ platform: 'TIKTOK' }, {});
        assert.equal(result.isError, true);
        assert.equal(calls.filter((c) => c.url === '/v1/accounts/can-connect').length, 2);
        assert.equal(authorizeCalls().length, 0);
    }],
    ['reconnect with accountId only: platform from /v1/accounts, body {platform, accountId}', async () => {
        const result = await handleConnectAccount({ accountId: 7 }, {});
        assert.equal(result.isError, undefined);
        assert.deepEqual(calls.map((c) => c.url), ['/v1/accounts', '/v1/accounts/oauth/authorize-url']);
        assert.deepEqual(authorizeCalls()[0].body, { platform: 'LINKEDIN', accountId: 7 });
        assert.match(text(result), /\[Reconnect LinkedIn\]/);
    }],
    ['reconnect with unknown accountId: error, no authorize-url', async () => {
        const result = await handleConnectAccount({ accountId: 999 }, {});
        assert.equal(result.isError, true);
        assert.match(text(result), /account 999 not found/);
        assert.equal(authorizeCalls().length, 0);
    }],
    ['reconnect with platform mismatch: error', async () => {
        const result = await handleConnectAccount({ accountId: 7, platform: 'INSTAGRAM' }, {});
        assert.equal(result.isError, true);
        assert.match(text(result), /is a LINKEDIN account, not INSTAGRAM/);
        assert.equal(authorizeCalls().length, 0);
    }],
    ['Telegram: guidance text, no API call', async () => {
        const result = await handleConnectAccount({ platform: 'TELEGRAM' }, {});
        assert.equal(result.isError, undefined);
        assert.match(text(result), /post-pulse\.com\/app\/accounts/);
        assert.equal(calls.length, 0);
    }],
    ['Telegram reconnect by accountId: guidance text', async () => {
        const result = await handleConnectAccount({ accountId: 8 }, {});
        assert.equal(result.isError, undefined);
        assert.match(text(result), /cannot be connected with a link/);
        assert.equal(authorizeCalls().length, 0);
    }],
    ['neither platform nor accountId: error', async () => {
        const result = await handleConnectAccount({}, {});
        assert.equal(result.isError, true);
        assert.equal(calls.length, 0);
    }],
    ['accountId 0 (null coerced by zod) with platform: treated as a new connection', async () => {
        const result = await handleConnectAccount({ platform: 'THREADS', accountId: 0 }, {});
        assert.equal(result.isError, undefined);
        assert.deepEqual(authorizeCalls()[0].body, { platform: 'THREADS' });
    }],
    ['authorize-url 400: mapped "not supported" error', async () => {
        postHandler = (url) => { throw httpError(400, url, { error: 'Unsupported platform' }); };
        const result = await handleConnectAccount({ platform: 'YOUTUBE' }, {});
        assert.equal(result.isError, true);
        assert.match(text(result), /connecting YouTube with a link is not supported/);
    }],
    ['401: session expired error', async () => {
        getHandler = (url) => { throw httpError(401, url, {}); };
        const result = await handleConnectAccount({ platform: 'YOUTUBE' }, {});
        assert.equal(result.isError, true);
        assert.match(text(result), /session has expired/);
    }],
    ['elicitation: client without elicitation.url gets text only', async () => {
        let elicited = false;
        const elicitor = {
            getClientCapabilities: () => ({ elicitation: { form: {} } }),
            elicitInput: async () => { elicited = true; return { action: 'accept' }; },
        } as unknown as UrlElicitor;
        const result = await handleConnectAccount({ platform: 'LINKEDIN' }, {}, elicitor);
        assert.equal(elicited, false);
        assert.ok(text(result).startsWith('[Connect LinkedIn]'));
    }],
    ['elicitation: sends url mode + relatedRequestId and mentions the dialog', async () => {
        let params: any;
        let options: any;
        const elicitor = {
            getClientCapabilities: () => ({ elicitation: { url: {} } }),
            elicitInput: async (p: any, o: any) => { params = p; options = o; return { action: 'accept' }; },
        } as unknown as UrlElicitor;
        const result = await handleConnectAccount({ platform: 'LINKEDIN' }, { requestId: 42 }, elicitor);
        assert.equal(params.mode, 'url');
        assert.equal(params.url, CONSENT_URL);
        assert.ok(params.elicitationId);
        assert.equal(options.relatedRequestId, 42);
        assert.match(text(result), /^Your MCP client also shows this link in a dialog/);
        assert.ok(text(result).includes(CONSENT_URL));
    }],
    ['elicitation: the tool result does not wait for the dialog answer', async () => {
        // Regression: clients time out tool calls after ~60 s, and MCP Inspector answers the
        // dialog only after the user has finished the platform consent.
        const elicitor = {
            getClientCapabilities: () => ({ elicitation: { url: {} } }),
            elicitInput: () => new Promise(() => { /* never answered */ }),
        } as unknown as UrlElicitor;
        const outcome = await Promise.race([
            handleConnectAccount({ platform: 'LINKEDIN' }, {}, elicitor).then(() => 'returned'),
            new Promise((resolve) => setTimeout(() => resolve('blocked'), 200)),
        ]);
        assert.equal(outcome, 'returned');
    }],
    ['elicitation: a rejected dialog request does not affect the result', async () => {
        const elicitor = {
            getClientCapabilities: () => ({ elicitation: { url: {} } }),
            elicitInput: async () => { throw new Error('Request timed out'); },
        } as unknown as UrlElicitor;
        const result = await handleConnectAccount({ platform: 'LINKEDIN' }, {}, elicitor);
        await new Promise((resolve) => setImmediate(resolve)); // let the rejection be handled
        assert.equal(result.isError, undefined);
        assert.ok(text(result).includes(CONSENT_URL));
    }],
];

async function run() {
    let failed = 0;
    for (const [name, fn] of tests) {
        reset();
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
