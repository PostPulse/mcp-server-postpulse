import './setup_env';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createMcpHandler, type McpSessions } from '../src/mcp_handler';
import { SessionRegistry } from '../src/session_registry';
import { redisEventStores } from '../src/store/redis_event_store';
import { logger } from '../src/logger';
import { fakeRedis } from './fake_redis';

// The wiring of src/index.ts: the real handler, the real SDK server transport and a RedisEventStore per session, on
// Redis streams kept in memory. With one store for all sessions (the code before plan 022) the first two cases fail:
// the SDK checks that the session of a GET exists, not whose event its Last-Event-ID names.

type LogLine = Record<string, unknown> & { message: string };
const logLines: LogLine[] = [];
(logger as any).info = (first: unknown, second?: string) => {
    logLines.push(typeof first === 'string' ? { message: first } : { ...(first as object), message: second ?? '' });
};
const logged = (text: string) => logLines.filter((line) => line.message.endsWith(text));

const { redis, streams } = fakeRedis();
const sessions: McpSessions = new SessionRegistry({ idleMs: 60 * 60 * 1000 });
/** The server of each session, in the order the sessions started. */
const servers: McpServer[] = [];
/** The responses of the GET requests that carry a Last-Event-ID. */
const resumeResponses: express.Response[] = [];

let slowStarted = 0;
let finishSlow = () => {};

async function waitFor(what: string, condition: () => boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

function createServer() {
    const server = new McpServer({ name: 'test', version: '1.0.0' }, { capabilities: { logging: {} } });
    server.registerTool('echo', { description: 'Echo', inputSchema: { text: z.string() } }, async ({ text }) => ({
        content: [{ type: 'text' as const, text }],
    }));
    server.registerTool('slow', { description: 'Runs until the test lets it finish', inputSchema: {} }, async () => {
        slowStarted += 1;
        await new Promise<void>((resolve) => { finishSlow = resolve; });
        return { content: [{ type: 'text' as const, text: 'RESULT-OF-THE-SLOW-CALL' }] };
    });
    // Closes the response stream of its own call, as a server does for a long call, and answers once the client has
    // come back for it: a result sent while no stream of the call is open is lost by the SDK.
    server.registerTool('interrupted', { description: 'Breaks its stream, then answers', inputSchema: {} }, async (_args, extra) => {
        if (!extra.closeSSEStream) throw new Error('no closeSSEStream: no event store, or the client protocol is too old');
        const resumesBefore = resumeResponses.length;
        extra.closeSSEStream();
        await waitFor('the client to resume', () => resumeResponses.slice(resumesBefore).some((res) => res.headersSent));
        return { content: [{ type: 'text' as const, text: 'RESULT-AFTER-THE-BREAK' }] };
    });
    servers.push(server);
    return server;
}

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    // Stands for the token check of the real server: a POST gets `req.auth`, GET and DELETE pass without one.
    if (req.method === 'POST') (req as any).auth = { clientId: 'client-1' };
    if (req.method === 'GET' && req.headers['last-event-id']) resumeResponses.push(res);
    next();
});
app.all('/', createMcpHandler({
    sessions,
    createServer,
    createEventStore: redisEventStores(redis),
    landingHtml: '<html></html>',
}));

const httpServer = http.createServer(app);
let port = 0;

before(async () => {
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    port = (httpServer.address() as AddressInfo).port;
});

after(() => {
    httpServer.closeAllConnections();
    httpServer.close();
});

interface RawRequest {
    method?: 'GET' | 'POST';
    sessionId?: string;
    body?: object;
    lastEventId?: string;
    /** How long to read: a replay stream stays open, so what arrived by then is the answer. */
    readMs?: number;
    /** Drop the connection after the first chunk, as a network break does. */
    dropAfterFirstChunk?: boolean;
}

/** A raw request of a client on the latest protocol; returns what arrived before the response ended or `readMs` passed. */
function request({ method = 'POST', sessionId, body, lastEventId, readMs = 300, dropAfterFirstChunk = false }: RawRequest) {
    return new Promise<{ status: number; text: string; sessionId?: string }>((resolve) => {
        const payload = body ? JSON.stringify(body) : undefined;
        let text = '';
        let settled = false;
        const req = http.request({
            host: '127.0.0.1', port, path: '/', method,
            headers: {
                accept: method === 'GET' ? 'text/event-stream' : 'application/json, text/event-stream',
                'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
                ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
                ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
                ...(lastEventId !== undefined ? { 'last-event-id': lastEventId } : {}),
            },
        }, (res) => {
            const done = () => {
                if (settled) return;
                settled = true;
                req.destroy();
                resolve({ status: res.statusCode!, text, sessionId: res.headers['mcp-session-id'] as string | undefined });
            };
            res.on('data', (chunk) => {
                text += chunk;
                if (dropAfterFirstChunk) done();
            });
            res.on('end', done);
            res.on('error', () => {});
            setTimeout(done, readMs);
        });
        req.on('error', () => {});
        if (payload) req.write(payload);
        req.end();
    });
}

async function initialize() {
    const answer = await request({
        body: {
            jsonrpc: '2.0', id: 1, method: 'initialize',
            params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
        },
    });
    assert.equal(answer.status, 200, answer.text);
    return { sessionId: answer.sessionId!, server: servers[servers.length - 1] };
}

const call = (sessionId: string, name: string, args: object, extra: RawRequest = {}) =>
    request({ sessionId, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }, readMs: 2000, ...extra });

const eventIds = (text: string) => [...text.matchAll(/^id: (.+)$/gm)].map((match) => match[1]);
const streamOf = (eventId: string) => eventId.slice(0, eventId.lastIndexOf('::'));

test('a message sent outside a call is replayed only to its own session, though every session names that stream the same', async () => {
    const a = await initialize();
    const b = await initialize();
    // No GET stream is open, so the SDK only stores the message, under the stream ID it gives every session.
    await a.server.server.sendLoggingMessage({ level: 'info', data: 'NOTIFICATION-FOR-A' });

    const replayB = await request({ method: 'GET', sessionId: b.sessionId, lastEventId: '_GET_stream::0-0' });
    assert.equal(replayB.status, 200);
    assert.doesNotMatch(replayB.text, /NOTIFICATION-FOR-A/);

    const replayA = await request({ method: 'GET', sessionId: a.sessionId, lastEventId: '_GET_stream::0-0' });
    assert.equal(replayA.status, 200);
    assert.match(replayA.text, /NOTIFICATION-FOR-A/);
});

test('a tool result is replayed only to its own session, even to one that knows its event ID', async () => {
    const a = await initialize();
    const b = await initialize();
    const result = await call(a.sessionId, 'echo', { text: 'PRIVATE-RESULT-OF-A' });
    assert.match(result.text, /PRIVATE-RESULT-OF-A/);
    const lastEventOfA = eventIds(result.text).pop()!;
    const firstEventOfA = `${streamOf(lastEventOfA)}::0-0`;

    const replayB = await request({ method: 'GET', sessionId: b.sessionId, lastEventId: firstEventOfA });
    assert.equal(replayB.status, 200);
    assert.doesNotMatch(replayB.text, /PRIVATE-RESULT-OF-A/);

    const replayA = await request({ method: 'GET', sessionId: a.sessionId, lastEventId: firstEventOfA });
    assert.match(replayA.text, /PRIVATE-RESULT-OF-A/);
});

test('every event is kept under the ID of the session that sent it', async () => {
    const a = await initialize();
    const keysBefore = new Set(streams.keys());
    await call(a.sessionId, 'echo', { text: 'x' });
    await a.server.server.sendLoggingMessage({ level: 'info', data: 'y' });

    const newKeys = [...streams.keys()].filter((key) => !keysBefore.has(key));
    assert.equal(newKeys.length, 2, `the stream of the call and the GET stream: ${newKeys}`);
    for (const key of newKeys) assert.ok(key.startsWith(`mcp:events:${a.sessionId}:`), key);
    assert.ok(newKeys.includes(`mcp:events:${a.sessionId}:_GET_stream`));
    assert.equal(streams.has('mcp:events:_GET_stream'), false);
});

test('a real SDK client gets the result of a call whose stream the server closed: it resumes with Last-Event-ID', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/`), {
        reconnectionOptions: { initialReconnectionDelay: 20, maxReconnectionDelay: 100, reconnectionDelayGrowFactor: 1, maxRetries: 2 },
    });
    const errors: string[] = [];
    transport.onerror = (error) => errors.push(error.message);
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(transport);
    const sessionId = transport.sessionId!;

    const result = await client.callTool({ name: 'interrupted', arguments: {} });
    assert.deepEqual(result.content, [{ type: 'text', text: 'RESULT-AFTER-THE-BREAK' }]);
    assert.deepEqual(logged(`MCP Session resume requested: ${sessionId}`).map((line) => line.found), [true]);
    assert.deepEqual(errors, []);

    await transport.terminateSession();
    await client.close();
});

test('a call whose connection breaks: a GET with the last event ID, sent while the call runs, gets the result', async () => {
    const a = await initialize();
    const startedBefore = slowStarted;
    const busyBefore = sessions.stats().busy;
    const broken = await call(a.sessionId, 'slow', {}, { dropAfterFirstChunk: true });
    // A client on protocol 2025-11-25 gets a priming event with an ID before anything else.
    const [primingEventId] = eventIds(broken.text);
    assert.ok(primingEventId, broken.text);
    assert.doesNotMatch(broken.text, /RESULT-OF-THE-SLOW-CALL/);
    await waitFor('the call to start', () => slowStarted > startedBefore);
    // The server has seen the break: the SDK has let go of the stream of the call. (A result sent now, before the client
    // is back, would be lost: SDK 1.26 stores a message only while a stream of its call is open.)
    await waitFor('the server to see the break', () => sessions.stats().busy <= busyBefore);

    const resumesBefore = resumeResponses.length;
    const resumed = request({ method: 'GET', sessionId: a.sessionId, lastEventId: primingEventId, readMs: 2000 });
    await waitFor('the resumed stream', () => resumeResponses.slice(resumesBefore).some((res) => res.headersSent));
    finishSlow();

    const answer = await resumed;
    assert.equal(answer.status, 200);
    assert.match(answer.text, /RESULT-OF-THE-SLOW-CALL/);
});

test('a resume is logged with whether the session was found; a GET without Last-Event-ID is not', async () => {
    const a = await initialize();
    const gone = randomUUID();
    const before = logLines.length;

    const toGone = await request({ method: 'GET', sessionId: gone, lastEventId: '_GET_stream::0-0' });
    assert.equal(toGone.status, 404);
    await request({ method: 'GET', sessionId: a.sessionId, lastEventId: '' }); // the SDK ignores an empty one
    await request({ method: 'GET', sessionId: a.sessionId, readMs: 50 });
    // GET carries no token: anyone can send any text as the session ID, and the line keeps only its start.
    await request({ method: 'GET', sessionId: 'x'.repeat(2000), lastEventId: '_GET_stream::0-0' });

    assert.deepEqual(logLines.slice(before), [
        { found: false, message: `MCP Session resume requested: ${gone}` },
        { method: 'GET', initialize: false, clientId: undefined, message: `MCP Session not found: ${gone}` },
        { found: false, message: `MCP Session resume requested: ${'x'.repeat(64)}` },
        { method: 'GET', initialize: false, clientId: undefined, message: `MCP Session not found: ${'x'.repeat(64)}` },
    ]);
});
