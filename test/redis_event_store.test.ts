import './setup_env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisEventStore, redisEventStores } from '../src/store/redis_event_store';
import { fakeRedis } from './fake_redis';

const TWO_HOURS_SECONDS = 2 * 60 * 60;
const SESSION_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SESSION_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const MESSAGE = { jsonrpc: '2.0', id: 1, result: {} } as any;

async function replay(store: RedisEventStore, lastEventId: string) {
    const sent: Array<{ eventId: string; message: unknown }> = [];
    const streamId = await store.replayEventsAfter(lastEventId, {
        send: async (eventId, message) => {
            sent.push({ eventId, message });
        },
    });
    return { streamId, sent };
}

test('an event is kept under the session and the stream, and expires in two hours', async () => {
    const { redis, expires } = fakeRedis();
    const eventId = await new RedisEventStore(redis, SESSION_A).storeEvent('stream-1', MESSAGE);

    // The event ID a client sees does not change: the session is known from the request.
    assert.equal(eventId, 'stream-1::1-0');
    assert.deepEqual(expires, [{ key: `mcp:events:${SESSION_A}:stream-1`, seconds: TWO_HOURS_SECONDS }]);
});

test('every write to a stream starts its two hours again', async () => {
    const { redis, expires } = fakeRedis();
    const store = new RedisEventStore(redis, SESSION_A);
    await store.storeEvent('stream-1', MESSAGE);
    await store.storeEvent('stream-1', MESSAGE);

    assert.deepEqual(expires.map((call) => call.seconds), [TWO_HOURS_SECONDS, TWO_HOURS_SECONDS]);
});

test('a reconnect after the stream has expired replays nothing and does not fail', async () => {
    const { redis } = fakeRedis();
    const { streamId, sent } = await replay(new RedisEventStore(redis, SESSION_A), 'stream-1::1-0');

    assert.equal(streamId, 'stream-1');
    assert.deepEqual(sent, []);
});

test('a reconnect in time replays the events after the last one', async () => {
    const { redis } = fakeRedis();
    const store = new RedisEventStore(redis, SESSION_A);
    const first = await store.storeEvent('stream-1', MESSAGE);
    const second = await store.storeEvent('stream-1', { ...MESSAGE, id: 2 });

    const { streamId, sent } = await replay(store, first);
    assert.equal(streamId, 'stream-1');
    assert.deepEqual(sent, [{ eventId: second, message: { ...MESSAGE, id: 2 } }]);
});

test('a session replays only its own events, by a known event ID or by the shared ID of the GET stream', async () => {
    const { redis, streams, reads } = fakeRedis();
    const stores = redisEventStores(redis);
    const a = stores(SESSION_A);
    const b = stores(SESSION_B);
    // The SDK gives the standalone GET stream of every session the same ID.
    await a.storeEvent('_GET_stream', { jsonrpc: '2.0', method: 'notifications/message', params: { data: 'for A' } } as any);
    const callOfA = await a.storeEvent('call-of-a', MESSAGE);
    await b.storeEvent('_GET_stream', { jsonrpc: '2.0', method: 'notifications/message', params: { data: 'for B' } } as any);

    assert.deepEqual([...streams.keys()], [
        `mcp:events:${SESSION_A}:_GET_stream`,
        `mcp:events:${SESSION_A}:call-of-a`,
        `mcp:events:${SESSION_B}:_GET_stream`,
    ]);

    const streamOfA = callOfA.slice(0, callOfA.lastIndexOf('::'));
    assert.deepEqual((await replay(b, `${streamOfA}::0-0`)).sent, []);
    const getOfB = await replay(b, '_GET_stream::0-0');
    assert.deepEqual(getOfB.sent.map((event) => (event.message as any).params.data), ['for B']);
    assert.ok(reads.every((key) => key.startsWith(`mcp:events:${SESSION_B}:`)), `B read only its keys: ${reads}`);

    // A itself still gets both.
    assert.deepEqual((await replay(a, `${streamOfA}::0-0`)).sent.map((event) => event.message), [MESSAGE]);
    assert.deepEqual((await replay(a, '_GET_stream::0-0')).sent.map((event) => (event.message as any).params.data), ['for A']);
});

test('an event ID without the separator replays nothing', async () => {
    const { redis, reads } = fakeRedis();
    const { streamId, sent } = await replay(new RedisEventStore(redis, SESSION_A), 'no-separator');

    assert.equal(streamId, '');
    assert.deepEqual(sent, []);
    assert.deepEqual(reads, []);
});

test('a store without a session ID is refused: it would share one key across sessions again', () => {
    const { redis } = fakeRedis();
    assert.throws(() => new RedisEventStore(redis, ''), /needs the ID of its session/);
    assert.throws(() => redisEventStores(redis)(''), /needs the ID of its session/);
});
