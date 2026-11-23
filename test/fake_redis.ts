/**
 * Redis streams in memory, for RedisEventStore: what XADD writes, XRANGE reads back by key (only the exclusive start
 * `(<id>` to `+`, which is all the store asks for). Records the keys read and the TTLs set. Set `failures.write` or
 * `failures.read` to make XADD or XRANGE reject, as ioredis does when Redis is gone.
 */
export function fakeRedis() {
    const streams = new Map<string, Array<[string, string[]]>>();
    const expires: Array<{ key: string; seconds: number }> = [];
    const reads: string[] = [];
    const failures: { write?: Error; read?: Error } = {};
    let sequence = 0;
    const redis = {
        xadd: async (key: string, _id: string, field: string, value: string) => {
            if (failures.write) throw failures.write;
            const id = `${++sequence}-0`;
            streams.set(key, [...(streams.get(key) ?? []), [id, [field, value]]]);
            return id;
        },
        expire: async (key: string, seconds: number) => {
            expires.push({ key, seconds });
            return 1;
        },
        xrange: async (key: string, start: string) => {
            if (failures.read) throw failures.read;
            reads.push(key);
            const after = Number(start.replace('(', '').split('-')[0]);
            return (streams.get(key) ?? []).filter(([id]) => Number(id.split('-')[0]) > after);
        },
    };
    return { redis: redis as any, streams, expires, reads, failures };
}
