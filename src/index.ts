import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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

// ─── MCP Server Setup ────────────────────────────────────────────────────────

const mcpServerUrl = new URL(config.PUBLIC_URL || `http://${config.HOST}:${config.PORT}`);

const server = new McpServer({
    name: 'mcp-server-postpulse',
    version: '1.0.0',
});

// Register tools
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

// Single stateful transport instance
const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
});

// Connect server to transport
server.connect(transport).catch(error => {
    console.error('Failed to connect MCP server to transport:', error);
});

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
    // Note: MCP client will do their own discovery on the issuer.
    // However, the SDK requires these fields for its internal metadata server.
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

app.post('/', authMiddleware, async (req, res) => {
    await transport.handleRequest(req, res, req.body);
});

app.post('/sse', async (req, res) => {
    await transport.handleRequest(req, res, req.body);
});

app.get('/sse', async (req, res) => {
    await transport.handleRequest(req, res, req.body);
});

app.listen(config.PORT, config.HOST, () => {
    console.log(`🚀 PostPulse MCP Server: http://${config.HOST}:${config.PORT}`);
    if (config.PUBLIC_URL) {
        console.log(`🌍 Public URL: ${config.PUBLIC_URL}`);
    }
});
