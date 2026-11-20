/** What the registry needs from a session's transport. */
export interface SessionTransport {
    /** Ends the session's GET stream, if it has one. A live client opens it again; a client that is gone does not. */
    closeStandaloneSSEStream(): void;
}

/** What the registry needs from a session's server: it is closed, with its transport, when the session expires. */
export interface Closable {
    close(): Promise<void>;
}

/** The part of an HTTP response the registry listens to: `close` fires when the response ends or its connection drops. */
export interface ResponseLike {
    /** Either one is true once `close` has fired: a listener added after that never runs. */
    readonly closed?: boolean;
    readonly destroyed?: boolean;
    once(event: 'close', listener: () => void): unknown;
}

interface Entry<T> {
    transport: T;
    server: Closable;
    /** When a request of the session last started or ended. */
    lastActivity: number;
    /** Requests of the session whose response is still open: a running tool call or a GET stream. */
    inFlight: number;
    /** Of those, the GET requests: the session's stream. */
    streams: number;
    /** A sweep has ended the GET stream and nothing has happened since, so the next sweep leaves the session alone. */
    streamEnded: boolean;
}

export interface ExpiredSession {
    sessionId: string;
    idleMs: number;
    /** Requests still open when the session was closed: only after the hard limit of twice the idle limit. */
    openRequests: number;
}

export interface SweepResult {
    /** Sessions removed from the map, whether or not their close succeeded. */
    expired: ExpiredSession[];
    /** Sessions whose close (or the close of their GET stream) threw. */
    failed: Array<{ sessionId: string; error: unknown }>;
    /** Sessions past the idle limit whose open GET stream was ended, so that only a live client keeps them. */
    streamsClosed: string[];
}

export interface SessionRegistryOptions {
    /** A session with no request started or ended for this long is closed, or has its GET stream ended if it is busy. */
    idleMs: number;
    now?: () => number;
}

/**
 * The live MCP sessions of this process. Most clients never send DELETE, so a session would stay until the next restart:
 * about 150 KB each (its own McpServer with every tool). The registry closes it instead:
 *
 * - no open request and no request started or ended within `idleMs`: the session is closed;
 * - an open GET stream but no activity within `idleMs`: the stream carries nothing and so never shows that its client
 *   is gone. The stream is ended, once: a live client opens it again (activity), a client that is gone does not, and
 *   the session is closed one `idleMs` later;
 * - no activity within twice `idleMs`, open request or not: the session is closed. This bounds a request that never
 *   ends, whatever the reason (a running call is not touched before that).
 *
 * A client that comes back to a closed session gets 404 `Session not found`, the same answer as after a restart.
 */
export class SessionRegistry<T extends SessionTransport> {
    private readonly sessions = new Map<string, Entry<T>>();
    private readonly idleMs: number;
    private readonly now: () => number;

    constructor(options: SessionRegistryOptions) {
        this.idleMs = options.idleMs;
        this.now = options.now ?? Date.now;
    }

    add(sessionId: string, transport: T, server: Closable): void {
        this.sessions.set(sessionId, { transport, server, lastActivity: this.now(), inFlight: 0, streams: 0, streamEnded: false });
    }

    get(sessionId: string): T | undefined {
        return this.sessions.get(sessionId)?.transport;
    }

    /** Forgets a session the client closed itself (DELETE): the SDK has already closed it. */
    remove(sessionId: string): void {
        this.sessions.delete(sessionId);
    }

    /**
     * Counts a request of the session as open until its response closes; its start and its end are both activity.
     * `isStream` marks a GET request: the session's stream, which a sweep may end.
     */
    track(sessionId: string, res: ResponseLike, isStream = false): void {
        const entry = this.sessions.get(sessionId);
        if (!entry) return;
        this.touch(entry);
        // A client can drop the connection before the handler runs (while its token is checked). `close` has fired by
        // then, so the request is over already: counting it would leave the session busy for good.
        if (res.closed || res.destroyed) return;
        entry.inFlight += 1;
        if (isStream) entry.streams += 1;
        res.once('close', () => {
            entry.inFlight -= 1;
            if (isStream) entry.streams -= 1;
            this.touch(entry);
        });
    }

    private touch(entry: Entry<T>): void {
        entry.lastActivity = this.now();
        entry.streamEnded = false;
    }

    /**
     * Applies the rules above. A closed session leaves the map before anything is awaited, so a request that comes in
     * while it closes already gets 404 instead of a transport that is shutting down. Never rejects.
     */
    async sweep(): Promise<SweepResult> {
        const now = this.now();
        const result: SweepResult = { expired: [], failed: [], streamsClosed: [] };
        const closing: Array<{ sessionId: string; entry: Entry<T> }> = [];

        for (const [sessionId, entry] of this.sessions) {
            const idleMs = now - entry.lastActivity;
            if (idleMs <= this.idleMs) continue;
            if (entry.inFlight === 0 || idleMs > 2 * this.idleMs) {
                this.sessions.delete(sessionId);
                result.expired.push({ sessionId, idleMs, openRequests: entry.inFlight });
                closing.push({ sessionId, entry });
                continue;
            }
            // Only a running call is open, or the stream was ended by an earlier sweep and its response has not closed
            // (a stream that replays another request's events is not the one the SDK ends): the hard limit is next.
            if (entry.streams === 0 || entry.streamEnded) continue;
            entry.streamEnded = true;
            try {
                entry.transport.closeStandaloneSSEStream();
                result.streamsClosed.push(sessionId);
            } catch (error) {
                result.failed.push({ sessionId, error });
            }
        }

        // A session enters the map only after server.connect(transport), and McpServer.close() closes that transport
        // (its open streams and its pending responses) as well.
        const outcomes = await Promise.allSettled(closing.map(({ entry }) => entry.server.close()));
        outcomes.forEach((outcome, i) => {
            if (outcome.status === 'rejected') result.failed.push({ sessionId: closing[i].sessionId, error: outcome.reason });
        });
        return result;
    }

    /** `sessions` in the map, of which `busy` have an open request right now. */
    stats(): { sessions: number; busy: number } {
        let busy = 0;
        for (const entry of this.sessions.values()) if (entry.inFlight > 0) busy += 1;
        return { sessions: this.sessions.size, busy };
    }

    /**
     * Sweeps every `intervalMs` and hands each result to `onSweep`. Anything `onSweep` throws goes to `onError`, so the
     * timer never produces an unhandled rejection. The timer does not keep the process alive.
     */
    startSweeping(
        intervalMs: number,
        onSweep: (result: SweepResult) => void,
        onError: (error: unknown) => void,
    ): NodeJS.Timeout {
        const timer = setInterval(() => {
            this.sweep().then(onSweep).catch(onError);
        }, intervalMs);
        timer.unref();
        return timer;
    }
}
