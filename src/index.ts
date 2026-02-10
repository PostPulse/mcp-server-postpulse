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

// ─── OAuth Metadata ──────────────────────────────────────────────────────────

const mcpServerUrl = new URL(config.PUBLIC_URL || `http://${config.HOST}:${config.PORT}`);

const oauthMetadata: OAuthMetadata = {
    issuer: config.POSTPULSE_AUTH_ISSUER,
    authorization_endpoint: config.POSTPULSE_AUTH_AUTHORIZE_URL,
    token_endpoint: config.POSTPULSE_AUTH_TOKEN_URL,
    response_types_supported: ['code'],
};

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

// ─── MCP Server Factory ─────────────────────────────────────────────────────

const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

function createMcpServer() {
    const server = new McpServer({
        name: 'mcp-server-postpulse',
        version: '1.0.0',
    });

    // Modern registerTool signature using config object
    server.registerTool(listAccountsTool.name, {
        description: listAccountsTool.description,
        inputSchema: listAccountsTool.inputSchema as any
    }, handleListAccounts as any);

    server.registerTool(listChatsTool.name, {
        description: listChatsTool.description,
        inputSchema: listChatsTool.inputSchema as any
    }, handleListChats as any);

    server.registerTool(uploadMediaTool.name, {
        description: uploadMediaTool.description,
        inputSchema: uploadMediaTool.inputSchema as any
    }, handleUploadMedia as any);

    server.registerTool(schedulePostTool.name, {
        description: schedulePostTool.description,
        inputSchema: schedulePostTool.inputSchema as any
    }, handleSchedulePost as any);

    return server;
}

// ─── HTTP Handlers ───────────────────────────────────────────────────────────

const mcpPostHandler = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
                transports[sid] = transport;
            },
        });

        transport.onclose = () => {
            if (transport.sessionId) {
                delete transports[transport.sessionId];
            }
        };

        const server = createMcpServer();
        await server.connect(transport);
    } else {
        res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
            id: null,
        });
        return;
    }

    await transport.handleRequest(req, res, req.body);
};

const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send('Invalid or missing session ID');
        return;
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
};

// ─── Routes ──────────────────────────────────────────────────────────────────

app.post('/', authMiddleware, mcpPostHandler);
app.get('/', authMiddleware, handleSessionRequest);
app.delete('/', authMiddleware, handleSessionRequest);

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(config.PORT, config.HOST, () => {
    console.log(`🚀 PostPulse MCP Server: ${mcpServerUrl.origin}`);
});
