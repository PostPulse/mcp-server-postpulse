import './setup_env';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createMcpHandler, type McpSessions } from '../src/mcp_handler';
import { SessionRegistry } from '../src/session_registry';
import { logger } from '../src/logger';

// The real handler, the real SDK server transport and the real SDK client: if an SDK upgrade changes when a response
// emits `close`, how a GET stream ends or what a client does then, these tests fail instead of expiry breaking silently.

type LogLine = Record<string, unknown> & { message: string };
const logLines: LogLine[] = [];
(logger as any).info = (first: unknown, second?: string) => {
    logLines.push(typeof first === 'string' ? { message: first } : { ...(first as object), message: second ?? '' });
};
/** The log lines whose message ends with `text` (some messages start with an emoji). */
const logged = (text: string) => logLines.filter((line) => line.message.endsWith(text));

const IDLE = 60 * 60 * 1000;
let clock = Date.now();
const advance = (ms: number) => { clock += ms; };

const sessions: McpSessions = new SessionRegistry({ idleMs: IDLE, now: () => clock });
let started = 0;

let slowStarted = 0;
let finishSlow = () => {};

function createServer() {
    const server = new McpServer({ name: 'test', version: '1.0.0' });
    server.registerTool('echo', { description: 'Echo', inputSchema: { text: z.string() } }, async ({ text }) => ({
        content: [{ type: 'text' as const, text }],
    }));
    server.registerTool('slow', { description: 'Runs until the test lets it finish', inputSchema: {} }, async () => {
        slowStarted += 1;
        await new Promise<void>((resolve) => { finishSlow = resolve; });
        return { content: [{ type: 'text' as const, text: 'done' }] };
    });
    return server;
}

const app = express();
app.use(express.json());
let getRequests = 0;
app.use((req, _res, next) => {
    if (req.method === 'GET') getRequests += 1;
    next();
});
// Stands for the token check of the real server: a POST gets `req.auth`, GET and DELETE pass without one. With the
// header `x-hold-auth` the check does not finish until the test lets it, as a check that waits for the key set.
let heldAuth: { finish: () => void; connectionClosed: boolean } | undefined;
app.use((req, res, next) => {
    if (req.method === 'POST') (req as any).auth = { clientId: 'client-1' };
    if (!req.headers['x-hold-auth']) {
        next();
        return;
    }
    const held = { finish: () => next(), connectionClosed: false };
    res.once('close', () => { held.connectionClosed = true; });
    heldAuth = held;
});
app.all('/', createMcpHandler({
    sessions,
    createServer,
    eventStore: new InMemoryEventStore(),
    landingHtml: '<html></html>',
    onSessionStarted: () => { started += 1; },
}));

let baseUrl = '';

async function waitFor(what: string, condition: () => boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(sessions.stats())}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function connect() {
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
        reconnectionOptions: { initialReconnectionDelay: 20, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1, maxRetries: 2 },
    });
    const errors: string[] = [];
    transport.onerror = (error) => errors.push(error.message);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    return { client, transport, errors };
}

async function echo(client: Client, text: string) {
    const result = await client.callTool({ name: 'echo', arguments: { text } });
    return (result.content as Array<{ text: string }>)[0].text;
}

/** A raw request with a session ID, as a client that keeps an old one sends it. `query` goes after the URL. */
async function raw(method: 'GET' | 'POST', sessionId: string, body?: object, query = '') {
    const response = await fetch(baseUrl + query, {
        method,
        headers: {
            'content-type': 'application/json',
            accept: method === 'GET' ? 'text/event-stream' : 'application/json, text/event-stream',
            ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    return { status: response.status, text, sessionId: response.headers.get('mcp-session-id') };
}

async function sweepAll() {
    return sessions.sweep();
}

const INITIALIZE = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
};

const tests: Array<[string, () => Promise<void>]> = [
    ['a client that goes away without DELETE: its session expires and then answers 404', async () => {
        const { client, transport } = await connect();
        const sessionId = transport.sessionId!;
        assert.equal(await echo(client, 'hi'), 'hi');
        // The SDK client opens a GET stream after initialize; the registry sees it as an open request.
        await waitFor('the GET stream', () => sessions.stats().busy === 1);
        await client.close(); // aborts the GET stream, sends no DELETE
        await waitFor('the GET stream to close', () => sessions.stats().busy === 0);

        advance(IDLE + 1);
        const result = await sweepAll();
        assert.deepEqual(result.expired.map((e) => e.sessionId), [sessionId]);
        assert.deepEqual(sessions.stats(), { sessions: 0, busy: 0 });

        const post = await raw('POST', sessionId, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        assert.equal(post.status, 404);
        assert.deepEqual(JSON.parse(post.text), { jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null });
        const get = await raw('GET', sessionId);
        assert.equal(get.status, 404);
        assert.equal(get.text, 'Session not found');
        // Both are in the log; the POST carries a token, so its line names the client.
        const message = `MCP Session not found: ${sessionId}`;
        assert.deepEqual(logged(message), [
            { method: 'POST', initialize: false, clientId: 'client-1', message },
            { method: 'GET', initialize: false, clientId: undefined, message },
        ]);
    }],
    ['initialize with an expired session ID starts a new session instead of 404', async () => {
        const { client, transport } = await connect();
        const oldId = transport.sessionId!;
        await client.close();
        await waitFor('the GET stream to close', () => sessions.stats().busy === 0);
        advance(IDLE + 1);
        await sweepAll();
        const before = started;

        const init = await raw('POST', oldId, INITIALIZE);
        assert.equal(init.status, 200, init.text);
        assert.ok(init.sessionId && init.sessionId !== oldId, 'a new session ID');
        assert.ok(sessions.get(init.sessionId!), 'the new session is in the map');
        assert.equal(started, before + 1);
        // Not the old session: it stays gone.
        assert.equal(sessions.get(oldId), undefined);
        // The log ties the two by the client: the request to the old session and the session started for it. (The GET
        // the closed client had already sent may reach the server after the sweep and add a line of its own.)
        const notFound = `MCP Session not found: ${oldId}`;
        assert.deepEqual(
            logged(notFound).filter((line) => line.method === 'POST'),
            [{ method: 'POST', initialize: true, clientId: 'client-1', message: notFound }],
        );
        assert.deepEqual(logged(`MCP Session started: ${init.sessionId}`).map((line) => line.clientId), ['client-1']);
        advance(IDLE + 1);
        await sweepAll();
    }],
    ['a live client: its GET stream is ended after the idle limit, it opens a new one and the session stays', async () => {
        const { client, transport, errors } = await connect();
        const sessionId = transport.sessionId!;
        await waitFor('the GET stream', () => sessions.stats().busy === 1);

        const getsBefore = getRequests;
        advance(IDLE + 1);
        const result = await sweepAll();
        assert.deepEqual(result.streamsClosed, [sessionId]);
        assert.deepEqual(result.expired, []);
        // The SDK client reconnects the GET stream by itself; that counts as activity.
        await waitFor('the client to reopen its GET stream', () => getRequests > getsBefore && sessions.stats().busy === 1);

        advance(IDLE);
        assert.deepEqual((await sweepAll()).expired, []);
        assert.equal(await echo(client, 'still here'), 'still here');
        assert.deepEqual(errors, []);
        await transport.terminateSession();
        await client.close();
        assert.deepEqual(sessions.stats(), { sessions: 0, busy: 0 });
    }],
    ['a GET stream whose client is gone: ended after the limit, the session closed one limit later', async () => {
        // A raw GET stream that nobody reconnects stands for a client whose laptop went to sleep: the server never
        // hears from it again, and the stream stays open until the server ends it.
        const init = await raw('POST', '', INITIALIZE);
        const sessionId = init.sessionId!;
        const stream = await fetch(baseUrl, { headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId } });
        assert.equal(stream.status, 200);
        await waitFor('the GET stream', () => sessions.stats().busy === 1);

        advance(IDLE + 1);
        assert.deepEqual((await sweepAll()).streamsClosed, [sessionId]);
        await waitFor('the stream to end', () => sessions.stats().busy === 0);
        await stream.text(); // the body ends: the server closed it
        advance(IDLE + 1);
        assert.deepEqual((await sweepAll()).expired.map((e) => e.sessionId), [sessionId]);
        const post = await raw('POST', sessionId, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
        assert.equal(post.status, 404);
    }],
    ['DELETE from the client removes the session at once', async () => {
        const { client, transport } = await connect();
        await waitFor('the GET stream', () => sessions.stats().busy === 1);
        await transport.terminateSession();
        await client.close();
        assert.deepEqual(sessions.stats(), { sessions: 0, busy: 0 });
    }],
    ['a request dropped while its token is checked does not leave the session busy', async () => {
        const sessionId = (await raw('POST', '', INITIALIZE)).sessionId!;
        const payload = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        heldAuth = undefined;
        const request = http.request(baseUrl, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
                accept: 'application/json, text/event-stream',
                'mcp-session-id': sessionId,
                'x-hold-auth': '1',
            },
        });
        request.on('error', () => {});
        request.end(payload);
        await waitFor('the request to reach the token check', () => heldAuth !== undefined);
        request.destroy();
        await waitFor('the server to see the dropped connection', () => heldAuth!.connectionClosed);
        // Express still runs the handler: its response has emitted `close` already.
        heldAuth!.finish();
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepEqual(sessions.stats(), { sessions: 1, busy: 0 });

        advance(IDLE + 1);
        const result = await sweepAll();
        assert.deepEqual(result.streamsClosed, []);
        assert.deepEqual(result.expired.map((e) => [e.sessionId, e.openRequests]), [[sessionId, 0]]);
    }],
    ['a running call past the idle limit: nothing is ended or reported, and the call gets its result', async () => {
        const sessionId = (await raw('POST', '', INITIALIZE)).sessionId!;
        const startedBefore = slowStarted;
        const call = raw('POST', sessionId, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slow', arguments: {} } });
        await waitFor('the call to start', () => slowStarted > startedBefore);

        advance(IDLE + 1);
        assert.deepEqual(await sweepAll(), { expired: [], failed: [], streamsClosed: [] });
        assert.deepEqual(sessions.stats(), { sessions: 1, busy: 1 });

        finishSlow();
        const answer = await call;
        assert.equal(answer.status, 200);
        assert.match(answer.text, /"text":"done"/);
        await waitFor('the response of the call to close', () => sessions.stats().busy === 0);
        advance(IDLE + 1);
        assert.deepEqual((await sweepAll()).expired.map((e) => e.sessionId), [sessionId]);
    }],
    ['a session ID in the query string is not read: the request is one without a session', async () => {
        const sessionId = (await raw('POST', '', INITIALIZE)).sessionId!;
        advance(IDLE); // one more millisecond without a request and the session expires
        const logBefore = logLines.length;
        const noSessionPost = { jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: Initialize flow must start with a POST request' }, id: null };

        for (const id of [sessionId, '11111111-2222-3333-4444-555555555555']) {
            for (const query of [`?session_id=${id}`, `?mcp-session-id=${id}`]) {
                const get = await raw('GET', '', undefined, query);
                assert.equal(get.status, 400, `GET ${query}`);
                assert.equal(get.text, 'Mcp-Session-Id header is required for SSE');
                const post = await raw('POST', '', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, query);
                assert.equal(post.status, 400, `POST ${query}`);
                assert.deepEqual(JSON.parse(post.text), noSessionPost);
            }
        }
        // Nothing looked a session up by these IDs, and none of the requests was activity of the live session.
        assert.deepEqual(logLines.slice(logBefore), []);
        assert.deepEqual(sessions.stats(), { sessions: 1, busy: 0 });
        advance(1);
        assert.deepEqual((await sweepAll()).expired.map((e) => e.sessionId), [sessionId]);
    }],
    ['a GET with a long text in place of a session ID: 404, and the log line keeps only its start', async () => {
        const before = logLines.length;
        const get = await raw('GET', 'x'.repeat(2000));
        assert.equal(get.status, 404);
        assert.deepEqual(logLines.slice(before).map((line) => line.message), [`MCP Session not found: ${'x'.repeat(64)}`]);
    }],
];

const server = http.createServer(app);
server.listen(0, '127.0.0.1', async () => {
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
        for (const [name, run] of tests) {
            await run();
            console.log(`ok - ${name}`);
        }
        server.closeAllConnections();
        server.close();
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
});
