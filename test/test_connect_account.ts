import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import { handleConnectAccount, UrlElicitor, CONNECTABLE_PLATFORMS, connectAccountTool } from '../src/tools/connect_account';

// ─── Manual mock of the API client ──────────────────────────────────────────

const LINK_URL = 'https://post-pulse.com/oauth/connect/secret-link-token';

interface Call { method: 'GET' | 'POST'; url: string; body?: any }

let calls: Call[] = [];
let getHandler: (url: string) => any = () => { throw new Error('unexpected GET'); };
let postHandler: (url: string, body: any) => any = () => ({ data: { url: LINK_URL, expiresAt: '2026-10-02T12:00:00Z' } });

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
    getHandler = (url) => {
        if (url === '/v1/accounts/can-connect') return { data: { allowed: true } };
        if (url === '/v1/accounts') return { data: ACCOUNTS };
        throw new Error(`unexpected GET ${url}`);
    };
    postHandler = () => ({ data: { url: LINK_URL, expiresAt: '2026-10-02T12:00:00Z' } });
}

const text = (result: any) => result.content.map((c: any) => c.text).join('\n');
const linkCalls = () => calls.filter((c) => c.url === '/v1/accounts/connect-links');

// ─── Tests ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
    ['new connection: can-connect, then connect-links with {platform, origin: MCP}', async () => {
        const result = await handleConnectAccount({ platform: 'LINKEDIN' }, {});
        assert.equal(result.isError, undefined);
        assert.deepEqual(calls.map((c) => c.url), ['/v1/accounts/can-connect', '/v1/accounts/connect-links']);
        assert.deepEqual(linkCalls()[0].body, { platform: 'LINKEDIN', origin: 'MCP' });
        assert.match(text(result), /\[Connect LinkedIn\]\(https:\/\/post-pulse\.com\/oauth\/connect\//);
        assert.ok(text(result).includes(LINK_URL));
        assert.match(text(result), /24 hours/);
        assert.match(text(result), /return to your chat/);
        assert.match(text(result), /Do not share it/);
        assert.doesNotMatch(text(result), /opens the PostPulse app instead/);
    }],
    ['Bluesky: same 24-hour wording, no 5-minute caveat', async () => {
        const result = await handleConnectAccount({ platform: 'BLUE_SKY' }, {});
        assert.match(text(result), /24 hours/);
        assert.doesNotMatch(text(result), /5 minutes/);
    }],
    ['platform notes: Facebook points to list_chats', async () => {
        const result = await handleConnectAccount({ platform: 'FACEBOOK' }, {});
        assert.match(text(result), /list_chats with platform FACEBOOK/);
    }],
    ['can-connect false (seat limit): error with billing link, no connect-links', async () => {
        getHandler = () => ({ data: { allowed: false, reason: 'You have reached the maximum number of accounts allowed by your subscription.' } });
        const result = await handleConnectAccount({ platform: 'INSTAGRAM' }, {});
        assert.equal(result.isError, true);
        assert.match(text(result), /maximum number of accounts/);
        assert.match(text(result), /post-pulse\.com\/app\/billing/);
        assert.equal(linkCalls().length, 0);
    }],
    ['can-connect false: a single check, no retry', async () => {
        getHandler = () => ({ data: { allowed: false, reason: 'No active subscription found' } });
        const result = await handleConnectAccount({ platform: 'TIKTOK' }, {});
        assert.equal(result.isError, true);
        assert.equal(calls.filter((c) => c.url === '/v1/accounts/can-connect').length, 1);
        assert.equal(linkCalls().length, 0);
    }],
    ['platform description lists every connectable platform', async () => {
        const description = connectAccountTool.inputSchema.shape.platform.description ?? '';
        for (const platform of CONNECTABLE_PLATFORMS) {
            assert.ok(description.includes(platform), `${platform} missing from the description`);
        }
    }],
    ['reconnect with accountId only: platform from /v1/accounts, body {platform, accountId, origin: MCP}', async () => {
        const result = await handleConnectAccount({ accountId: 7 }, {});
        assert.equal(result.isError, undefined);
        assert.deepEqual(calls.map((c) => c.url), ['/v1/accounts', '/v1/accounts/connect-links']);
        assert.deepEqual(linkCalls()[0].body, { platform: 'LINKEDIN', accountId: 7, origin: 'MCP' });
        assert.match(text(result), /\[Reconnect LinkedIn\]/);
    }],
    ['reconnect with unknown accountId: error, no connect-links', async () => {
        const result = await handleConnectAccount({ accountId: 999 }, {});
        assert.equal(result.isError, true);
        assert.match(text(result), /account 999 not found/);
        assert.equal(linkCalls().length, 0);
    }],
    ['reconnect with platform mismatch: error', async () => {
        const result = await handleConnectAccount({ accountId: 7, platform: 'INSTAGRAM' }, {});
        assert.equal(result.isError, true);
        assert.match(text(result), /is a LINKEDIN account, not INSTAGRAM/);
        assert.equal(linkCalls().length, 0);
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
        assert.match(text(result), /list_chats with platform TELEGRAM/);
        assert.equal(linkCalls().length, 0);
    }],
    ['neither platform nor accountId: error', async () => {
        const result = await handleConnectAccount({}, {});
        assert.equal(result.isError, true);
        assert.equal(calls.length, 0);
    }],
    ['accountId 0 (null coerced by zod) with platform: treated as a new connection', async () => {
        const result = await handleConnectAccount({ platform: 'THREADS', accountId: 0 }, {});
        assert.equal(result.isError, undefined);
        assert.deepEqual(linkCalls()[0].body, { platform: 'THREADS', origin: 'MCP' });
    }],
    ['connect-links 400: mapped "not supported" error', async () => {
        postHandler = (url) => { throw httpError(400, url, { error: 'Unsupported platform' }); };
        const result = await handleConnectAccount({ platform: 'YOUTUBE' }, {});
        assert.equal(result.isError, true);
        assert.match(text(result), /connecting YouTube with a link is not supported/);
    }],
    ['connect-links 403 (seats ran out after can-connect): billing error with the reason', async () => {
        postHandler = (url) => { throw httpError(403, url, { error: 'You have reached the maximum number of accounts allowed by your subscription.' }); };
        const result = await handleConnectAccount({ platform: 'INSTAGRAM' }, {});
        assert.equal(result.isError, true);
        assert.match(text(result), /cannot be connected right now: You have reached the maximum number of accounts/);
        assert.match(text(result), /post-pulse\.com\/app\/billing/);
    }],
    ['connect-links 429: retry-later error', async () => {
        postHandler = (url) => { throw httpError(429, url, { error: 'Too many connect links; please try again later' }); };
        const result = await handleConnectAccount({ platform: 'LINKEDIN' }, {});
        assert.equal(result.isError, true);
        assert.match(text(result), /too many connection links were requested/);
    }],
    ['403 from another endpoint is not mapped to the billing error', async () => {
        getHandler = (url) => { throw httpError(403, url, { error: 'Forbidden' }); };
        const result = await handleConnectAccount({ platform: 'LINKEDIN' }, {});
        assert.equal(result.isError, true);
        assert.doesNotMatch(text(result), /app\/billing/);
        assert.match(text(result), /Forbidden/);
    }],
    ['empty url in the connect-links response: error', async () => {
        postHandler = () => ({ data: {} });
        const result = await handleConnectAccount({ platform: 'LINKEDIN' }, {});
        assert.equal(result.isError, true);
        assert.match(text(result), /did not return a connection link/);
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
        assert.equal(params.url, LINK_URL);
        assert.match(params.message, /Open this PostPulse page to connect LinkedIn/);
        assert.ok(params.elicitationId);
        assert.equal(options.relatedRequestId, 42);
        assert.match(text(result), /^Your MCP client also shows this link in a dialog/);
        assert.ok(text(result).includes(LINK_URL));
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
        assert.ok(text(result).includes(LINK_URL));
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
