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

// Main MCP endpoint
app.post('/', authMiddleware, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId) {
        // Subsequent request for an existing session
        const transport = transports.get(sessionId);
        if (!transport) {
            res.status(404).json({
                jsonrpc: '2.0',
                error: { code: -32001, message: 'Session not found' },
                id: null,
            });
            return;
        }
        await transport.handleRequest(req, res, req.body);
    } else if (isInitializeRequest(req.body)) {
        // Fresh initialization request
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
    } else {
        // No session ID and not an initialize request
        res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required or initiate initialize flow' },
            id: null,
        });
    }
});

// GET /sse and POST /sse for streaming
const handleSse = async (req: express.Request, res: express.Response) => {
    const sessionId = (req.headers['mcp-session-id'] as string) || (req.query['session_id'] as string);
    if (!sessionId) {
        res.status(400).send('Mcp-Session-Id header or session_id query parameter is required');
        return;
    }

    const transport = transports.get(sessionId);
    if (!transport) {
        res.status(404).send('Session not found');
        return;
    }

    await transport.handleRequest(req, res, req.body);
};

app.get('/sse', handleSse);
app.post('/sse', handleSse);

app.listen(config.PORT, config.HOST, () => {
    console.log(`🚀 PostPulse MCP Server: http://${config.HOST}:${config.PORT}`);
    if (config.PUBLIC_URL) {
        console.log(`🌍 Public URL: ${config.PUBLIC_URL}`);
    }
});
