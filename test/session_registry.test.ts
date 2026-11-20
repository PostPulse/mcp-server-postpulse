import './setup_env';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SessionRegistry } from '../src/session_registry';

const MINUTE = 60 * 1000;
const IDLE = 120 * MINUTE;

let clock = 0;
const advance = (ms: number) => { clock += ms; };

/** A transport whose GET stream is an open response that ends when the server closes it. */
function fakeTransport() {
    const transport = {
        streamsClosed: 0,
        stream: undefined as undefined | { end: () => void },
        closeStandaloneSSEStream: () => {
            transport.streamsClosed += 1;
            transport.stream?.end();
            transport.stream = undefined;
        },
    };
    return transport;
}

/** A server that records its close; McpServer.close() also closes its transport. */
function fakeServer() {
    const server = { closed: 0, close: async () => { server.closed += 1; } };
    return server;
}

function setup() {
    clock = 1_000_000;
    return new SessionRegistry<ReturnType<typeof fakeTransport>>({ idleMs: IDLE, now: () => clock });
}

/** An HTTP response that is still open until `end()`. */
const openResponse = () => {
    const res = new EventEmitter();
    return { res, end: () => res.emit('close') };
};

/** Opens a GET stream of the session: the transport ends it on closeStandaloneSSEStream. */
function openStream(registry: ReturnType<typeof setup>, sessionId: string, transport: ReturnType<typeof fakeTransport>) {
    const stream = openResponse();
    registry.track(sessionId, stream.res, true);
    transport.stream = stream;
    return stream;
}

const tests: Array<[string, () => Promise<void>]> = [
    ['a session with no request for longer than the limit is closed and leaves the map', async () => {
        const registry = setup();
        const server = fakeServer();
        registry.add('s1', fakeTransport(), server);
        advance(IDLE + 1);
        const result = await registry.sweep();
        assert.deepEqual(result, { expired: [{ sessionId: 's1', idleMs: IDLE + 1, openRequests: 0 }], failed: [], streamsClosed: [] });
        assert.equal(server.closed, 1);
        assert.equal(registry.get('s1'), undefined);
        assert.deepEqual(registry.stats(), { sessions: 0, busy: 0 });
    }],
    ['a session idle for exactly the limit or less stays', async () => {
        const registry = setup();
        const server = fakeServer();
        registry.add('s1', fakeTransport(), server);
        advance(IDLE);
        assert.deepEqual(await registry.sweep(), { expired: [], failed: [], streamsClosed: [] });
        assert.equal(server.closed, 0);
        assert.ok(registry.get('s1'));
    }],
    ['a request resets the idle time', async () => {
        const registry = setup();
        registry.add('s1', fakeTransport(), fakeServer());
        advance(IDLE - MINUTE);
        const call = openResponse();
        registry.track('s1', call.res);
        call.end();
        advance(IDLE - MINUTE);
        assert.equal((await registry.sweep()).expired.length, 0);
    }],
    ['a running call longer than the limit is not touched', async () => {
        const registry = setup();
        const transport = fakeTransport();
        const server = fakeServer();
        registry.add('s1', transport, server);
        openStream(registry, 's1', transport).end(); // a GET stream the client has closed is no stream any more
        const call = openResponse();
        registry.track('s1', call.res);
        advance(IDLE + MINUTE);
        // The call is not a GET stream, so there is nothing to end and nothing to report, on this sweep or the next.
        assert.deepEqual(await registry.sweep(), { expired: [], failed: [], streamsClosed: [] });
        advance(5 * MINUTE);
        assert.deepEqual(await registry.sweep(), { expired: [], failed: [], streamsClosed: [] });
        assert.equal(transport.streamsClosed, 0);
        assert.equal(server.closed, 0);
        assert.deepEqual(registry.stats(), { sessions: 1, busy: 1 });
        call.end();
        advance(IDLE + 1);
        assert.equal((await registry.sweep()).expired.length, 1);
    }],
    ['a GET stream past the limit is ended; a live client that opens it again keeps the session', async () => {
        const registry = setup();
        const transport = fakeTransport();
        const server = fakeServer();
        registry.add('s1', transport, server);
        openStream(registry, 's1', transport);
        advance(IDLE + 1);
        assert.deepEqual((await registry.sweep()).streamsClosed, ['s1']);
        assert.equal(transport.streamsClosed, 1);
        assert.deepEqual(registry.stats(), { sessions: 1, busy: 0 });
        openStream(registry, 's1', transport); // the client reconnects
        advance(IDLE);
        assert.deepEqual(await registry.sweep(), { expired: [], failed: [], streamsClosed: [] });
        assert.equal(server.closed, 0);
        // The same again one idle period later: the reopened stream is ended like the first one.
        advance(1);
        assert.deepEqual((await registry.sweep()).streamsClosed, ['s1']);
        assert.equal(transport.streamsClosed, 2);
    }],
    ['a GET stream that stays open after it was ended is ended and reported once, not on every sweep', async () => {
        const registry = setup();
        const transport = fakeTransport();
        const server = fakeServer();
        registry.add('s1', transport, server);
        // A stream the transport does not end, as one that replays the events of another request.
        registry.track('s1', openResponse().res, true);
        advance(IDLE + 1);
        assert.deepEqual((await registry.sweep()).streamsClosed, ['s1']);
        advance(5 * MINUTE);
        assert.deepEqual(await registry.sweep(), { expired: [], failed: [], streamsClosed: [] });
        advance(5 * MINUTE);
        assert.deepEqual(await registry.sweep(), { expired: [], failed: [], streamsClosed: [] });
        assert.equal(transport.streamsClosed, 1);
        // The hard limit still closes the session.
        advance(IDLE);
        assert.deepEqual((await registry.sweep()).expired.map((e) => e.openRequests), [1]);
        assert.equal(server.closed, 1);
    }],
    ['a request whose response has already closed is activity, not an open request', async () => {
        // A client that drops the connection while its token is checked: the handler still runs, `close` has fired.
        for (const gone of [{ destroyed: true }, { closed: true }]) {
            const registry = setup();
            const server = fakeServer();
            registry.add('s1', fakeTransport(), server);
            advance(IDLE - MINUTE);
            let listeners = 0;
            registry.track('s1', { ...gone, once: () => { listeners += 1; } });
            registry.track('s1', { ...gone, once: () => { listeners += 1; } }, true);
            assert.equal(listeners, 0);
            assert.deepEqual(registry.stats(), { sessions: 1, busy: 0 });
            advance(IDLE);
            assert.deepEqual(await registry.sweep(), { expired: [], failed: [], streamsClosed: [] }); // it was activity
            advance(1);
            assert.deepEqual((await registry.sweep()).expired, [{ sessionId: 's1', idleMs: IDLE + 1, openRequests: 0 }]);
            assert.equal(server.closed, 1);
        }
    }],
    ['a GET stream of a client that is gone: ended after the limit, the session closed one limit later', async () => {
        const registry = setup();
        const transport = fakeTransport();
        const server = fakeServer();
        registry.add('s1', transport, server);
        openStream(registry, 's1', transport);
        advance(IDLE + 1);
        assert.deepEqual((await registry.sweep()).streamsClosed, ['s1']);
        advance(IDLE);
        assert.equal((await registry.sweep()).expired.length, 0);
        advance(1);
        assert.deepEqual((await registry.sweep()).expired, [{ sessionId: 's1', idleMs: IDLE + 1, openRequests: 0 }]);
        assert.equal(server.closed, 1);
    }],
    ['a request that never ends: the session is closed after twice the limit anyway', async () => {
        const registry = setup();
        const transport = fakeTransport();
        const server = fakeServer();
        registry.add('s1', transport, server);
        registry.track('s1', openResponse().res); // never ends, and ending the GET stream does not end it
        advance(2 * IDLE);
        assert.equal((await registry.sweep()).expired.length, 0);
        advance(1);
        assert.deepEqual((await registry.sweep()).expired, [{ sessionId: 's1', idleMs: 2 * IDLE + 1, openRequests: 1 }]);
        assert.equal(server.closed, 1);
        assert.equal(registry.get('s1'), undefined);
    }],
    ['two open requests: the session is busy until both close', async () => {
        const registry = setup();
        registry.add('s1', fakeTransport(), fakeServer());
        const a = openResponse();
        const b = openResponse();
        registry.track('s1', a.res);
        registry.track('s1', b.res);
        a.end();
        advance(IDLE + 1);
        assert.equal((await registry.sweep()).expired.length, 0);
        b.end();
        advance(IDLE + 1);
        assert.equal((await registry.sweep()).expired.length, 1);
    }],
    ['only idle sessions are closed, the others stay', async () => {
        const registry = setup();
        const old = fakeServer();
        const fresh = fakeServer();
        registry.add('old', fakeTransport(), old);
        advance(IDLE);
        registry.add('fresh', fakeTransport(), fresh);
        advance(1);
        const result = await registry.sweep();
        assert.deepEqual(result.expired.map((e) => e.sessionId), ['old']);
        assert.equal(old.closed, 1);
        assert.equal(fresh.closed, 0);
        assert.deepEqual(registry.stats(), { sessions: 1, busy: 0 });
    }],
    ['a session leaves the map before its close finishes, so a request during the close gets no transport', async () => {
        const registry = setup();
        let finish: () => void = () => {};
        const slow = { close: () => new Promise<void>((resolve) => { finish = resolve; }) };
        registry.add('s1', fakeTransport(), slow);
        advance(IDLE + 1);
        const sweeping = registry.sweep();
        assert.equal(registry.get('s1'), undefined);
        finish();
        assert.equal((await sweeping).expired.length, 1);
    }],
    ['a failed close is reported and does not stop the others', async () => {
        const registry = setup();
        const good = fakeServer();
        const boom = new Error('boom');
        registry.add('bad', fakeTransport(), { close: async () => { throw boom; } });
        registry.add('good', fakeTransport(), good);
        advance(IDLE + 1);
        const result = await registry.sweep();
        assert.equal(result.expired.length, 2);
        assert.deepEqual(result.failed, [{ sessionId: 'bad', error: boom }]);
        assert.equal(good.closed, 1);
        assert.deepEqual(registry.stats(), { sessions: 0, busy: 0 });
    }],
    ['a GET stream that fails to end is reported, the session stays', async () => {
        const registry = setup();
        const boom = new Error('stream boom');
        const transport = { closeStandaloneSSEStream: () => { throw boom; } } as unknown as ReturnType<typeof fakeTransport>;
        registry.add('s1', transport, fakeServer());
        registry.track('s1', openResponse().res, true);
        advance(IDLE + 1);
        const result = await registry.sweep();
        assert.deepEqual(result.failed, [{ sessionId: 's1', error: boom }]);
        assert.deepEqual(result.streamsClosed, []);
        assert.equal(registry.stats().sessions, 1);
        // Not tried and not reported again on the next sweep.
        advance(5 * MINUTE);
        assert.deepEqual(await registry.sweep(), { expired: [], failed: [], streamsClosed: [] });
    }],
    ['DELETE removes the session; a request of it that ends later changes nothing', async () => {
        const registry = setup();
        const server = fakeServer();
        registry.add('s1', fakeTransport(), server);
        const call = openResponse();
        registry.track('s1', call.res);
        registry.remove('s1');
        call.end();
        assert.deepEqual(registry.stats(), { sessions: 0, busy: 0 });
        advance(IDLE + 1);
        assert.deepEqual(await registry.sweep(), { expired: [], failed: [], streamsClosed: [] });
        assert.equal(server.closed, 0);
    }],
    ['tracking a session that is not in the map is ignored', async () => {
        const registry = setup();
        registry.track('unknown', openResponse().res);
        assert.deepEqual(registry.stats(), { sessions: 0, busy: 0 });
    }],
    ['the sweep timer does not keep the process alive and reports each sweep', async () => {
        const registry = setup();
        const expired: number[] = [];
        const timer = registry.startSweeping(5, (result) => expired.push(result.expired.length), (error) => { throw error; });
        assert.equal(timer.hasRef(), false);
        registry.add('s1', fakeTransport(), fakeServer());
        advance(IDLE + 1);
        await new Promise((resolve) => setTimeout(resolve, 30));
        clearInterval(timer);
        assert.ok(expired.length >= 1);
        assert.equal(expired.reduce((a, b) => a + b, 0), 1);
    }],
    ['an error in the report of a sweep goes to onError, not to an unhandled rejection', async () => {
        const registry = setup();
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        const errors: unknown[] = [];
        const boom = new Error('report boom');
        const timer = registry.startSweeping(5, () => { throw boom; }, (error) => errors.push(error));
        await new Promise((resolve) => setTimeout(resolve, 30));
        clearInterval(timer);
        await new Promise((resolve) => setImmediate(resolve));
        process.off('unhandledRejection', onUnhandled);
        assert.ok(errors.length >= 1);
        assert.equal(errors[0], boom);
        assert.deepEqual(unhandled, []);
    }],
];

(async () => {
    for (const [name, run] of tests) {
        await run();
        console.log(`ok - ${name}`);
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
