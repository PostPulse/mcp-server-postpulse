import Redis from 'ioredis';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { EventStore, StreamId, EventId } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const KEY_PREFIX = 'mcp:events:';
// Every outgoing message is kept here, including tool results with secret links, so only as long as a reconnect needs it.
const EVENT_TTL_SECONDS = 7200; // 2 hours
const SEPARATOR = '::';

/**
 * The events of one MCP session in Redis (Streams: XADD/XRANGE), for the resume of a broken response stream: a client
 * whose connection drops sends a GET with `Last-Event-ID` and gets the messages sent after that event. The SDK (1.26)
 * stores a message only while a stream of its call is open, so a result that is ready before the client is back never
 * gets here and is lost.
 *
 * One store per session (see `redisEventStores`), with the session ID in the key, so a replay reads only the events of
 * the session that asks. The SDK transport checks that the session of the request exists, not whose event the ID names,
 * and the stream of the standalone GET has the same ID (`_GET_stream`) in every session.
 *
 * No resume after a restart or deploy: the session itself lives in the memory of the process, so a request to it then
 * gets 404 although its events are still here.
 *
 * Event ID format: `{streamId}::{redisStreamId}`
 * Redis key format: `mcp:events:{sessionId}:{streamId}`
 */
export class RedisEventStore implements EventStore {
    constructor(
        private readonly redis: Redis,
        private readonly sessionId: string,
    ) {
        // An empty ID would put the events of every such session under one key again.
        if (!sessionId) {
            throw new Error('RedisEventStore needs the ID of its session');
        }
    }

    private key(streamId: StreamId): string {
        return `${KEY_PREFIX}${this.sessionId}:${streamId}`;
    }

    async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
        const key = this.key(streamId);
        const redisStreamId = await this.redis.xadd(key, '*', 'message', JSON.stringify(message));
        // Refresh TTL on each write so active streams stay alive
        await this.redis.expire(key, EVENT_TTL_SECONDS);
        return `${streamId}${SEPARATOR}${redisStreamId}`;
    }

    async replayEventsAfter(
        lastEventId: EventId,
        { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
    ): Promise<StreamId> {
        const separatorIdx = lastEventId.lastIndexOf(SEPARATOR);
        if (separatorIdx === -1) {
            return '';
        }

        const streamId = lastEventId.substring(0, separatorIdx);
        const redisStreamId = lastEventId.substring(separatorIdx + SEPARATOR.length);

        // XRANGE with exclusive start: '(' prefix means "after this ID"
        const entries = await this.redis.xrange(this.key(streamId), `(${redisStreamId}`, '+');

        for (const [entryId, fields] of entries) {
            const eventId = `${streamId}${SEPARATOR}${entryId}`;
            const message: JSONRPCMessage = JSON.parse(fields[1]); // fields = ['message', '<json>']
            await send(eventId, message);
        }

        return streamId;
    }
}

/** Makes the store of each new session; all of them share one Redis connection. */
export function redisEventStores(redis: Redis): (sessionId: string) => RedisEventStore {
    return (sessionId) => new RedisEventStore(redis, sessionId);
}
