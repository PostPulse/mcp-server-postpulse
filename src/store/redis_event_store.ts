import Redis from 'ioredis';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { EventStore, StreamId, EventId } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const KEY_PREFIX = 'mcp:events:';
const EVENT_TTL_SECONDS = 86400; // 24 hours
const SEPARATOR = '::';

/**
 * Redis-backed EventStore for MCP session resumability.
 *
 * Uses Redis Streams (XADD/XRANGE) to persist SSE events so clients
 * can reconnect with Last-Event-ID and replay missed messages — even
 * after a server restart or deploy.
 *
 * Event ID format: `{streamId}::{redisStreamId}`
 * Redis key format: `mcp:events:{streamId}`
 */
export class RedisEventStore implements EventStore {
    constructor(private readonly redis: Redis) {}

    async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
        const key = `${KEY_PREFIX}${streamId}`;
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

        const key = `${KEY_PREFIX}${streamId}`;
        // XRANGE with exclusive start: '(' prefix means "after this ID"
        const entries = await this.redis.xrange(key, `(${redisStreamId}`, '+');

        for (const [entryId, fields] of entries) {
            const eventId = `${streamId}${SEPARATOR}${entryId}`;
            const message: JSONRPCMessage = JSON.parse(fields[1]); // fields = ['message', '<json>']
            await send(eventId, message);
        }

        return streamId;
    }
}
