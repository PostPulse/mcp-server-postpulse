import './setup_env';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { authThenParseBody, bodyTooLargeHandler, MAX_BODY_KB } from '../src/body_limit';
import { logger } from '../src/logger';

// ─── A small app with the same middleware and order as src/index.ts ─────────

const warnings: any[] = [];
(logger as any).warn = (fields: any, message: string) => warnings.push({ ...fields, message });

let passedOn: any[] = [];

const app = express();
app.use(authThenParseBody((req, res, next) => {
    if (req.headers.authorization !== 'Bearer good') {
        res.status(401).json({ error: 'invalid_token' });
        return;
    }
    (req as any).auth = { token: 'good', clientId: 'client-1', scopes: [], extra: { sub: 'auth0|user-1' } };
    next();
}));
app.all('/', (req, res) => {
    res.json({ method: req.method, body: req.body ?? null });
});
app.use(bodyTooLargeHandler);
app.use(((err, _req, res, _next) => {
    passedOn.push(err);
    res.status(err.status ?? 500).json({ passedOn: err.type });
}) as express.ErrorRequestHandler);

let baseUrl = '';

function oversized(): string {
    return JSON.stringify({ jsonrpc: '2.0', method: 'x', params: { data: 'a'.repeat((MAX_BODY_KB + 50) * 1024) } });
}

/** Reads the whole response, so that no test leaves a busy socket behind. */
async function send(method: string, body?: string, token?: string) {
    const response = await fetch(baseUrl, {
        method,
        headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body,
    });
    const text = await response.text();
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', json: () => JSON.parse(text) };
}

function post(body: string, token?: string) {
    return send('POST', body, token);
}

/** Sends a body without Content-Length, as chunked transfer encoding does. */
function postChunked(body: string): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(baseUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer good', 'transfer-encoding': 'chunked' },
        }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        });
        req.on('error', reject);
        req.end(body);
    });
}

function reset() {
    warnings.length = 0;
    passedOn = [];
}

const tests: Array<[string, () => Promise<void>]> = [
    ['a small POST with a token reaches the handler parsed', async () => {
        const response = await post('{"jsonrpc":"2.0"}', 'good');
        assert.equal(response.status, 200);
        assert.deepEqual(response.json(), { method: 'POST', body: { jsonrpc: '2.0' } });
    }],
    ['a body over the limit gets a JSON-RPC 413 that states the limit and the way out', async () => {
        const response = await post(oversized(), 'good');
        assert.equal(response.status, 413);
        assert.match(response.contentType, /application\/json/);
        const body = response.json();
        assert.equal(body.jsonrpc, '2.0');
        assert.equal(body.id, null);
        assert.equal(typeof body.error.code, 'number');
        assert.match(body.error.message, new RegExp(`${MAX_BODY_KB} KB`));
        assert.match(body.error.message, /mediaUrl/);
        assert.match(body.error.message, /https:\/\/post-pulse\.com\/app\/gallery/);
        assert.match(body.error.message, /list_media/);
    }],
    ['a body over the limit leaves a warning with its size and client, and without any content', async () => {
        const body = oversized();
        await post(body, 'good');
        assert.equal(warnings.length, 1);
        assert.deepEqual(warnings[0], {
            length: Buffer.byteLength(body),
            limit: MAX_BODY_KB * 1024,
            clientId: 'client-1',
            sub: 'auth0|user-1',
            message: 'MCP request body over the limit',
        });
    }],
    ['a chunked body over the limit is caught too and logs how far it got', async () => {
        const response = await postChunked(oversized());
        assert.equal(response.status, 413);
        assert.equal(warnings.length, 1);
        assert.ok(warnings[0].length > MAX_BODY_KB * 1024);
    }],
    ['a body at the limit passes', async () => {
        const envelope = JSON.stringify({ data: '' });
        const response = await post(JSON.stringify({ data: 'a'.repeat(MAX_BODY_KB * 1024 - envelope.length) }), 'good');
        assert.equal(response.status, 200);
    }],
    ['without a valid token a large body gets 401 and leaves no warning', async () => {
        const noToken = await post(oversized());
        assert.equal(noToken.status, 401);
        const badToken = await post(oversized(), 'bad');
        assert.equal(badToken.status, 401);
        assert.equal(warnings.length, 0);
    }],
    ['without a valid token the body is not parsed: malformed JSON gets 401, not 400', async () => {
        const noToken = await post('{not json');
        assert.equal(noToken.status, 401);
        assert.deepEqual(passedOn, []);
    }],
    ['other errors pass through untouched', async () => {
        const response = await post('{not json', 'good');
        assert.equal(response.status, 400);
        assert.deepEqual(response.json(), { passedOn: 'entity.parse.failed' });
        assert.equal(passedOn.length, 1);
        assert.equal(warnings.length, 0);
    }],
    ['other methods need no token and their body is not parsed', async () => {
        const get = await send('GET');
        assert.equal(get.status, 200);
        assert.deepEqual(get.json(), { method: 'GET', body: null });
        const del = await send('DELETE', oversized());
        assert.equal(del.status, 200);
        assert.deepEqual(del.json(), { method: 'DELETE', body: null });
    }],
];

async function run() {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    let failed = 0;
    for (const [name, fn] of tests) {
        reset();
        try {
            await fn();
            console.log(`ok - ${name}`);
        } catch (error: any) {
            failed++;
            console.error(`not ok - ${name}\n   ${error.message}`);
        }
    }
    console.log(`\n${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
}

run();
