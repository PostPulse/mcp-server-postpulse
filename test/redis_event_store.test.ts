import './setup_env';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RedisEventStore } from '../src/store/redis_event_store';

const TWO_HOURS_SECONDS = 2 * 60 * 60;
const MESSAGE = { jsonrpc: '2.0', id: 1, result: {} } as any;

function fakeRedis(entries: Array<[string, string[]]> = []) {
    const expires: Array<{ key: string; seconds: number }> = [];
    let sequence = 0;
    const redis = {
        xadd: async () => `${++sequence}-0`,
        expire: async (key: string, seconds: number) => {
            expires.push({ key, seconds });
            return 1;
        },
        xrange: async () => entries,
    };
    return { redis: redis as any, expires };
}

test('a stored event expires in two hours', async () => {
    const { redis, expires } = fakeRedis();
    const eventId = await new RedisEventStore(redis).storeEvent('stream-1', MESSAGE);

    assert.equal(eventId, 'stream-1::1-0');
    assert.deepEqual(expires, [{ key: 'mcp:events:stream-1', seconds: TWO_HOURS_SECONDS }]);
});

test('every write to a stream starts its two hours again', async () => {
    const { redis, expires } = fakeRedis();
    const store = new RedisEventStore(redis);
    await store.storeEvent('stream-1', MESSAGE);
    await store.storeEvent('stream-1', MESSAGE);

    assert.deepEqual(expires.map((call) => call.seconds), [TWO_HOURS_SECONDS, TWO_HOURS_SECONDS]);
});

test('a reconnect after the stream has expired replays nothing and does not fail', async () => {
    const { redis } = fakeRedis([]);
    const sent: unknown[] = [];
    const streamId = await new RedisEventStore(redis).replayEventsAfter('stream-1::1-0', {
        send: async (_eventId, message) => {
            sent.push(message);
        },
    });

    assert.equal(streamId, 'stream-1');
    assert.deepEqual(sent, []);
});

test('a reconnect in time replays the events after the last one', async () => {
    const { redis } = fakeRedis([['2-0', ['message', JSON.stringify(MESSAGE)]]]);
    const sent: Array<{ eventId: string; message: unknown }> = [];
    await new RedisEventStore(redis).replayEventsAfter('stream-1::1-0', {
        send: async (eventId, message) => {
            sent.push({ eventId, message });
        },
    });

    assert.deepEqual(sent, [{ eventId: 'stream-1::2-0', message: MESSAGE }]);
});
