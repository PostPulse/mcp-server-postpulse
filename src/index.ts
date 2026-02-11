import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import cors from 'cors';
import {
    mcpAuthMetadataRouter,
    getOAuthProtectedResourceMetadataUrl,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from './config';
import { tokenVerifier } from './auth/token_verifier';

// Import tools
import { listAccountsTool, handleListAccounts } from './tools/list_accounts';
import { listChatsTool, handleListChats } from './tools/list_chats';
import { uploadMediaTool, handleUploadMedia } from './tools/upload_media';
import { schedulePostTool, handleSchedulePost } from './tools/schedule_post';

// ─── MCP Server Factory ─────────────────────────────────────────────────────

const mcpServerUrl = new URL(config.PUBLIC_URL || `http://${config.HOST}:${config.PORT}`);

/**
 * Creates a fresh McpServer instance with all tools registered.
 */
function createMcpServer() {
    const server = new McpServer({
        name: 'mcp-server-postpulse',
        version: '1.0.0',
    });

    server.registerTool(listAccountsTool.name, {
        description: listAccountsTool.description,
        inputSchema: listAccountsTool.inputSchema
    }, handleListAccounts);

    server.registerTool(listChatsTool.name, {
        description: listChatsTool.description,
        inputSchema: listChatsTool.inputSchema
    }, handleListChats);

    server.registerTool(uploadMediaTool.name, {
        description: uploadMediaTool.description,
        inputSchema: uploadMediaTool.inputSchema
    }, handleUploadMedia);

    server.registerTool(schedulePostTool.name, {
        description: schedulePostTool.description,
        inputSchema: schedulePostTool.inputSchema
    }, handleSchedulePost);

    return server;
}

// ─── Transport Registry ──────────────────────────────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(
    cors({
        origin: '*',
        exposedHeaders: ['Mcp-Session-Id'],
    }),
);

// ─── OAuth Discovery Endpoints ───────────────────────────────────────────────

const issuerUrl = config.POSTPULSE_AUTH_ISSUER.endsWith('/')
    ? config.POSTPULSE_AUTH_ISSUER
    : `${config.POSTPULSE_AUTH_ISSUER}/`;

const oauthMetadata: OAuthMetadata = {
    issuer: config.POSTPULSE_AUTH_ISSUER,
    authorization_endpoint: `${issuerUrl}authorize`,
    token_endpoint: `${issuerUrl}oauth/token`,
    response_types_supported: ['code'],
};

app.use(
    mcpAuthMetadataRouter({
        oauthMetadata,
        resourceServerUrl: mcpServerUrl,
        scopesSupported: [
            'openid', 'profile', 'email', 'offline_access',
            'postpulse-api/accounts.read', 'postpulse-api/api',
            'postpulse-api/media.write', 'postpulse-api/posts.read',
            'postpulse-api/posts.write'
        ],
        resourceName: 'PostPulse MCP Server',
    }),
);

// ─── Auth Middleware ─────────────────────────────────────────────────────────

const authMiddleware = requireBearerAuth({
    verifier: tokenVerifier,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

// ─── MCP Request Handler ─────────────────────────────────────────────────────

/**
 * Unified handler for all MCP requests (POST and GET).
 * - POST with initialization request -> creates a new session.
 * - POST with sessionId header -> standard MCP tool call/request.
 * - GET with sessionId (header or query) -> establishes SSE stream.
 */
const handleMcp = async (req: express.Request, res: express.Response) => {
    // 1. Discover Session ID
    // Check headers first (standard), then query params (some SSE clients)
    let sessionId = (req.headers['mcp-session-id'] as string | undefined)
        || (req.query['session_id'] as string | undefined)
        || (req.query['mcp-session-id'] as string | undefined);

    // If session ID was only in query, inject it into headers for the SDK transport
    if (sessionId && !req.headers['mcp-session-id']) {
        req.headers['mcp-session-id'] = sessionId;
    }

    // 2. Handle Existing Session
    if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) {
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
        await transport.handleRequest(req, res, req.body);
        return;
    }

    // 3. Handle Initialization (POST only)
    if (req.method === 'POST' && isInitializeRequest(req.body)) {
        // Auth is required for initialization
        // Note: authMiddleware is already applied to the outer route, but we check here for clarity
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
                transports.set(sid, transport);
                console.log(`✨ MCP Session started: ${sid}`);
            },
            onsessionclosed: (sid) => {
                transports.delete(sid);
                console.log(`👋 MCP Session closed: ${sid}`);
            },
        });

        const server = createMcpServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
    }

    // 4. Fallback: Bad Request
    if (req.method === 'GET') {
        res.status(400).send('Mcp-Session-Id header or session_id query parameter is required for SSE');
    } else {
        res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: Initialize flow must start with a POST request' },
            id: null,
        });
    }
};

// ─── Routes ──────────────────────────────────────────────────────────────────

// The root path handles both POST (init/messages) and GET (SSE)
app.use((req, res, next) => {
    // Only apply auth to POST requests (initialization and subsequent messages)
    // GET requests (SSE) are authorized by the session ID itself (which was created with auth)
    if (req.method === 'POST') {
        return authMiddleware(req, res, next);
    }
    next();
});

app.all('/', handleMcp);
app.all('/sse', handleMcp);

app.listen(config.PORT, config.HOST, () => {
    console.log(`🚀 PostPulse MCP Server: http://${config.HOST}:${config.PORT}`);
    if (config.PUBLIC_URL) {
        console.log(`🌍 Public URL: ${config.PUBLIC_URL}`);
    }
});
