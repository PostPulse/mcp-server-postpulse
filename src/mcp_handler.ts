import * as Sentry from '@sentry/node';
import type express from 'express';
import { randomUUID } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport, type EventStore } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { logger } from './logger';
import { SessionRegistry, type SweepResult } from './session_registry';

export type McpSessions = SessionRegistry<StreamableHTTPServerTransport>;

/** A session ID is a UUID of 36 characters. GET and DELETE carry no token, so anyone can send any text in its place. */
const MAX_LOGGED_SESSION_ID = 64;

export interface McpHandlerOptions {
    sessions: McpSessions;
    /** A new McpServer with every tool: each session gets its own. */
    createServer: () => McpServer;
    /**
     * The event store of a new session, for the resume of a broken response stream. Each session needs its own: the SDK
     * does not check whose event a `Last-Event-ID` names, so with a shared store one session could replay another's.
     */
    createEventStore?: (sessionId: string) => EventStore;
    /** The page for a browser (or crawler) that opens the server URL. */
    landingHtml: string;
    /** Called after the initialize request of a new session has been answered. */
    onSessionStarted?: (req: express.Request) => void;
}

/**
 * Unified handler for all MCP requests (POST, GET and DELETE).
 * - POST with an initialize request -> creates a new session.
 * - POST with a session ID -> a request of that session (tool call etc.).
 * - GET with a session ID -> the session's SSE stream.
 * - DELETE with a session ID -> the client ends its session.
 */
export function createMcpHandler(options: McpHandlerOptions) {
    const { sessions, createServer, createEventStore, landingHtml, onSessionStarted } = options;

    return async (req: express.Request, res: express.Response) => {
        // 1. Discover Session ID
        // Only the header counts, as in the MCP specification: the SDK transport reads nothing else.
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        const isInitialize = req.method === 'POST' && isInitializeRequest(req.body);
        // The client of the token (POST only): it ties a request to a session that is gone to the session started next.
        const clientId = (req as express.Request & { auth?: AuthInfo }).auth?.clientId;

        // 2. Handle Existing Session
        if (sessionId) {
            const transport = sessions.get(sessionId);
            // A GET with Last-Event-ID asks to resume a broken stream (the SDK ignores an empty one). Logged to see
            // whether any client resumes at all: that is all the event store is for.
            if (req.method === 'GET' && req.headers['last-event-id']) {
                logger.info(
                    { found: transport !== undefined },
                    `MCP Session resume requested: ${sessionId.slice(0, MAX_LOGGED_SESSION_ID)}`,
                );
            }
            if (transport) {
                sessions.track(sessionId, res, req.method === 'GET');
                await transport.handleRequest(req, res, req.body);
                return;
            }
            // The session expired or the server restarted since.
            logger.info(
                { method: req.method, initialize: isInitialize, clientId },
                `MCP Session not found: ${sessionId.slice(0, MAX_LOGGED_SESSION_ID)}`,
            );
            if (!isInitialize) {
                if (req.method === 'GET') {
                    res.status(404).send('Session not found');
                } else {
                    res.status(404).json({
                        jsonrpc: '2.0',
                        error: { code: -32001, message: 'Session not found' },
                        id: null,
                    });
                }
                return;
            }
            // A client that starts over with initialize but still sends its old session ID gets a new session below:
            // an initialize request always means one, and the SDK does not check the session ID of such a request.
        }

        // 3. Handle Initialization (POST only)
        if (isInitialize) {
            // Made here rather than by the transport, so that the event store of the session can be bound to it.
            const newSessionId = randomUUID();
            const server = createServer();
            const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => newSessionId,
                eventStore: createEventStore?.(newSessionId),
                onsessioninitialized: (sid) => {
                    sessions.add(sid, transport, server);
                    logger.info({ clientId }, `✨ MCP Session started: ${sid}`);
                },
                onsessionclosed: (sid) => {
                    sessions.remove(sid);
                    logger.info(`👋 MCP Session closed: ${sid}`);
                },
            });

            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            onSessionStarted?.(req);
            return;
        }

        // 4. Fallback: Bad Request
        if (req.method === 'GET') {
            // A browser or crawler prefers HTML; an MCP client opening an SSE stream asks for
            // text/event-stream (and keeps getting the 400 below, as the SDK expects).
            if (req.accepts(['text/event-stream', 'text/html']) === 'text/html') {
                res.status(200).type('html').send(landingHtml);
                return;
            }
            res.status(400).send('Mcp-Session-Id header is required for SSE');
        } else {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: Initialize flow must start with a POST request' },
                id: null,
            });
        }
    };
}

/**
 * Logs one sweep: each closed session, each ended GET stream and each failed close (also to Sentry), then the size of
 * the map. Nothing is logged while the map is empty and nothing happened, so an idle server stays quiet in Loki.
 */
export function reportSweep(result: SweepResult, stats: { sessions: number; busy: number }): void {
    for (const { sessionId, idleMs, openRequests } of result.expired) {
        logger.info({ idleMinutes: Math.round(idleMs / 60000), openRequests }, `⌛ MCP Session expired: ${sessionId}`);
    }
    for (const sessionId of result.streamsClosed) {
        logger.info(`MCP Session GET stream ended after the idle limit: ${sessionId}`);
    }
    for (const { sessionId, error } of result.failed) {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, `MCP Session failed to close: ${sessionId}`);
        Sentry.captureException(error, { extra: { sessionId } });
    }
    const happened = result.expired.length + result.streamsClosed.length + result.failed.length;
    if (stats.sessions > 0 || happened > 0) {
        logger.info({
            ...stats,
            expired: result.expired.length,
            streamsClosed: result.streamsClosed.length,
            failed: result.failed.length,
        }, 'MCP sessions in memory');
    }
}

/** Sweeps the sessions every `intervalMs`; an error of the sweep or of its report goes to the log and Sentry. */
export function startSessionSweeper(sessions: McpSessions, intervalMs: number): NodeJS.Timeout {
    return sessions.startSweeping(
        intervalMs,
        (result) => reportSweep(result, sessions.stats()),
        (error) => {
            logger.error({ err: error instanceof Error ? error.message : String(error) }, 'MCP session sweep failed');
            Sentry.captureException(error);
        },
    );
}
