/** What the registry needs from a session's server: it is closed, with its transport, when the session expires. */
export interface Closable {
    close(): Promise<void>;
}

/** The part of an HTTP response the registry listens to: `close` fires when the response ends or its connection drops. */
export interface ResponseLike {
    once(event: 'close', listener: () => void): unknown;
}

interface Entry<T> {
    transport: T;
    server: Closable;
    /** When a request of the session last started or ended. */
    lastActivity: number;
    /** Requests of the session whose response is still open: a running tool call or a GET stream. */
    inFlight: number;
}

export interface ExpiredSession {
    sessionId: string;
    idleMs: number;
}

export interface SessionRegistryOptions {
    /** A session with no open request and no request for this long is closed. */
    idleMs: number;
    now?: () => number;
}

/**
 * The live MCP sessions of this process. Most clients never send DELETE, so a session would stay until the next restart:
 * about 150 KB each (its own McpServer with every tool). A session with no open request and no request within `idleMs`
 * is closed instead. A client that comes back gets 404 `Session not found`, the same answer as after a restart.
 */
export class SessionRegistry<T> {
    private readonly sessions = new Map<string, Entry<T>>();
    private readonly idleMs: number;
    private readonly now: () => number;

    constructor(options: SessionRegistryOptions) {
        this.idleMs = options.idleMs;
        this.now = options.now ?? Date.now;
    }

    add(sessionId: string, transport: T, server: Closable): void {
        this.sessions.set(sessionId, { transport, server, lastActivity: this.now(), inFlight: 0 });
    }

    get(sessionId: string): T | undefined {
        return this.sessions.get(sessionId)?.transport;
    }

    /** Forgets a session the client closed itself (DELETE): the SDK has already closed it. */
    remove(sessionId: string): void {
        this.sessions.delete(sessionId);
    }

    /** Counts a request of the session as open until its response closes; its start and its end are both activity. */
    track(sessionId: string, res: ResponseLike): void {
        const entry = this.sessions.get(sessionId);
        if (!entry) return;
        entry.inFlight += 1;
        entry.lastActivity = this.now();
        res.once('close', () => {
            entry.inFlight -= 1;
            entry.lastActivity = this.now();
        });
    }

    /**
     * Closes every idle session. Each one leaves the map before anything is awaited, so a request that comes in while
     * it closes already gets 404 instead of a transport that is shutting down.
     */
    async sweep(): Promise<ExpiredSession[]> {
        const now = this.now();
        const expired: Array<ExpiredSession & { entry: Entry<T> }> = [];
        for (const [sessionId, entry] of this.sessions) {
            const idleMs = now - entry.lastActivity;
            if (entry.inFlight === 0 && idleMs > this.idleMs) {
                this.sessions.delete(sessionId);
                expired.push({ sessionId, idleMs, entry });
            }
        }
        // A session enters the map only after server.connect(transport), and McpServer.close() closes that transport
        // (its open streams and its pending responses) as well.
        await Promise.allSettled(expired.map(({ entry }) => entry.server.close()));
        return expired.map(({ sessionId, idleMs }) => ({ sessionId, idleMs }));
    }

    /** `sessions` in the map, of which `busy` have an open request right now. */
    stats(): { sessions: number; busy: number } {
        let busy = 0;
        for (const entry of this.sessions.values()) if (entry.inFlight > 0) busy += 1;
        return { sessions: this.sessions.size, busy };
    }

    /** Sweeps every `intervalMs`. The timer does not keep the process alive. */
    startSweeping(intervalMs: number, onSweep: (expired: ExpiredSession[]) => void): NodeJS.Timeout {
        const timer = setInterval(() => {
            this.sweep().then(onSweep, () => { /* allSettled inside: never rejects */ });
        }, intervalMs);
        timer.unref();
        return timer;
    }
}
