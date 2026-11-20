import './setup_env';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SessionRegistry } from '../src/session_registry';

const MINUTE = 60 * 1000;
const IDLE = 120 * MINUTE;

let clock = 0;
const advance = (ms: number) => { clock += ms; };

/** A server that records its close; McpServer.close() also closes its transport. */
function fakeServer() {
    const server = { closed: 0, close: async () => { server.closed += 1; } };
    return server;
}

function setup() {
    clock = 1_000_000;
    return new SessionRegistry<{ name: string }>({ idleMs: IDLE, now: () => clock });
}

/** An HTTP response that is still open until `end()`. */
const openResponse = () => {
    const res = new EventEmitter();
    return { res, end: () => res.emit('close') };
};

const tests: Array<[string, () => Promise<void>]> = [
    ['a session with no request for longer than the limit is closed and leaves the map', async () => {
        const registry = setup();
        const server = fakeServer();
        registry.add('s1', { name: 't1' }, server);
        advance(IDLE + 1);
        const expired = await registry.sweep();
        assert.deepEqual(expired, [{ sessionId: 's1', idleMs: IDLE + 1 }]);
        assert.equal(server.closed, 1);
        assert.equal(registry.get('s1'), undefined);
        assert.deepEqual(registry.stats(), { sessions: 0, busy: 0 });
    }],
    ['a session idle for exactly the limit or less stays', async () => {
        const registry = setup();
        const server = fakeServer();
        registry.add('s1', { name: 't1' }, server);
        advance(IDLE);
        assert.deepEqual(await registry.sweep(), []);
        assert.equal(server.closed, 0);
        assert.deepEqual(registry.get('s1'), { name: 't1' });
    }],
    ['a request resets the idle time', async () => {
        const registry = setup();
        registry.add('s1', { name: 't1' }, fakeServer());
        advance(IDLE - MINUTE);
        const call = openResponse();
        registry.track('s1', call.res);
        call.end();
        advance(IDLE - MINUTE);
        assert.deepEqual(await registry.sweep(), []);
    }],
    ['a session with an open request (a running call or a GET stream) is kept however old', async () => {
        const registry = setup();
        const server = fakeServer();
        registry.add('s1', { name: 't1' }, server);
        const stream = openResponse();
        registry.track('s1', stream.res);
        advance(10 * IDLE);
        assert.deepEqual(await registry.sweep(), []);
        assert.deepEqual(registry.stats(), { sessions: 1, busy: 1 });
        assert.equal(server.closed, 0);
    }],
    ['the end of a long request counts as activity: the limit runs from there', async () => {
        const registry = setup();
        registry.add('s1', { name: 't1' }, fakeServer());
        const stream = openResponse();
        registry.track('s1', stream.res);
        advance(5 * IDLE);
        stream.end();
        advance(IDLE);
        assert.deepEqual(await registry.sweep(), []);
        advance(1);
        assert.equal((await registry.sweep()).length, 1);
    }],
    ['two open requests: the session is busy until both close', async () => {
        const registry = setup();
        registry.add('s1', { name: 't1' }, fakeServer());
        const a = openResponse();
        const b = openResponse();
        registry.track('s1', a.res);
        registry.track('s1', b.res);
        a.end();
        advance(IDLE + 1);
        assert.deepEqual(await registry.sweep(), []);
        b.end();
        advance(IDLE + 1);
        assert.equal((await registry.sweep()).length, 1);
    }],
    ['only idle sessions are closed, the others stay', async () => {
        const registry = setup();
        const old = fakeServer();
        const fresh = fakeServer();
        registry.add('old', { name: 'old' }, old);
        advance(IDLE);
        registry.add('fresh', { name: 'fresh' }, fresh);
        advance(1);
        const expired = await registry.sweep();
        assert.deepEqual(expired.map((e) => e.sessionId), ['old']);
        assert.equal(old.closed, 1);
        assert.equal(fresh.closed, 0);
        assert.deepEqual(registry.stats(), { sessions: 1, busy: 0 });
    }],
    ['a session leaves the map before its close finishes, so a request during the close gets no transport', async () => {
        const registry = setup();
        let finish: () => void = () => {};
        const slow = { close: () => new Promise<void>((resolve) => { finish = resolve; }) };
        registry.add('s1', { name: 't1' }, slow);
        advance(IDLE + 1);
        const sweeping = registry.sweep();
        assert.equal(registry.get('s1'), undefined);
        finish();
        assert.equal((await sweeping).length, 1);
    }],
    ['a server that fails to close does not stop the sweep of the others', async () => {
        const registry = setup();
        const good = fakeServer();
        registry.add('bad', { name: 'bad' }, { close: async () => { throw new Error('boom'); } });
        registry.add('good', { name: 'good' }, good);
        advance(IDLE + 1);
        assert.equal((await registry.sweep()).length, 2);
        assert.equal(good.closed, 1);
        assert.deepEqual(registry.stats(), { sessions: 0, busy: 0 });
    }],
    ['DELETE removes the session; a request of it that ends later changes nothing', async () => {
        const registry = setup();
        const server = fakeServer();
        registry.add('s1', { name: 't1' }, server);
        const call = openResponse();
        registry.track('s1', call.res);
        registry.remove('s1');
        call.end();
        assert.deepEqual(registry.stats(), { sessions: 0, busy: 0 });
        advance(IDLE + 1);
        assert.deepEqual(await registry.sweep(), []);
        assert.equal(server.closed, 0);
    }],
    ['tracking a session that is not in the map is ignored', async () => {
        const registry = setup();
        registry.track('unknown', openResponse().res);
        assert.deepEqual(registry.stats(), { sessions: 0, busy: 0 });
    }],
    ['the sweep timer does not keep the process alive and reports each sweep', async () => {
        const registry = setup();
        const reports: number[] = [];
        const timer = registry.startSweeping(5, (expired) => reports.push(expired.length));
        assert.equal(timer.hasRef(), false);
        registry.add('s1', { name: 't1' }, fakeServer());
        advance(IDLE + 1);
        await new Promise((resolve) => setTimeout(resolve, 30));
        clearInterval(timer);
        assert.ok(reports.length >= 1);
        assert.equal(reports.reduce((a, b) => a + b, 0), 1);
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
