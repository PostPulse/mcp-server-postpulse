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
import { z } from 'zod';
import Redis from 'ioredis';
import { config } from './config';
import { tokenVerifier } from './auth/token_verifier';
import { RedisEventStore } from './store/redis_event_store';

// Import tools
import { listAccountsTool, handleListAccounts } from './tools/list_accounts';
import { listChatsTool, handleListChats } from './tools/list_chats';
import { uploadMediaTool, handleUploadMedia } from './tools/upload_media';
import { schedulePostTool, handleSchedulePost } from './tools/schedule_post';

// Import resources
import { listAccountsResource, handleListAccountsResource } from './resources/accounts';

// ─── MCP Server Factory ─────────────────────────────────────────────────────

const mcpServerUrl = new URL(config.PUBLIC_URL || `http://${config.HOST}:${config.PORT}`);

/**
 * Creates a fresh McpServer instance with all tools and resources registered.
 */
function createMcpServer() {
    const server = new McpServer(
        {
            name: 'mcp-server-postpulse',
            version: '1.0.0',
        },
        {
            instructions: `You are connected to the PostPulse MCP Server, which lets you manage social media accounts and schedule posts across multiple platforms.

Typical workflow:
1. Call list_accounts to discover the user's connected social media accounts and their IDs.
2. If the user wants to post media, call upload_media first to upload the image or video. Use the returned media key in the next step.
3. Call schedule_post with the account ID, platform, content, optional media keys, and a scheduled time in ISO-8601 format.

Important notes:
- Always call list_accounts before schedule_post so you have a valid accountId.
- The scheduledTime must be a future ISO-8601 timestamp (e.g., 2025-06-15T14:00:00Z).
- For Instagram and Facebook, you can set publicationType to FEED, REEL, or STORY (defaults to FEED).
- For YouTube and TikTok, provide a title for the video.
- For Telegram and Facebook, you MUST first call list_chats to get the publishing destination (channel/chat ID or Page ID), then pass it as telegramChannelId or facebookPageId in schedule_post. list_chats only works for TELEGRAM and FACEBOOK platforms.
- upload_media accepts either a public URL (mediaUrl) or base64 data (mediaData + mediaType). It returns a media key string to pass into schedule_post's mediaPaths array.`,
        },
    );

    // Resources
    server.registerResource(
        listAccountsResource.name,
        listAccountsResource.uri,
        { description: listAccountsResource.description },
        handleListAccountsResource
    );

    // Tools
    server.registerTool(listAccountsTool.name, {
        title: 'List Accounts',
        description: listAccountsTool.description,
        inputSchema: listAccountsTool.inputSchema,
        annotations: {
            title: 'List Accounts',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, handleListAccounts);

    server.registerTool(listChatsTool.name, {
        title: 'List Publishing Destinations',
        description: listChatsTool.description,
        inputSchema: listChatsTool.inputSchema,
        annotations: {
            title: 'List Publishing Destinations',
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, handleListChats);

    server.registerTool(uploadMediaTool.name, {
        title: 'Upload Media',
        description: uploadMediaTool.description,
        inputSchema: uploadMediaTool.inputSchema,
        annotations: {
            title: 'Upload Media',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        },
    }, handleUploadMedia);

    server.registerTool(schedulePostTool.name, {
        title: 'Schedule Post',
        description: schedulePostTool.description,
        inputSchema: schedulePostTool.inputSchema,
        annotations: {
            title: 'Schedule Post',
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        },
    }, handleSchedulePost);

    // Prompts
    server.registerPrompt('schedule-post', {
        title: 'Schedule a Social Media Post',
        description: 'Guide through scheduling a post to a connected social media account. Walks through account selection, optional media upload, and post scheduling.',
        argsSchema: {
            platform: z.string().optional().describe('Target platform (e.g. INSTAGRAM, FACEBOOK, TELEGRAM, YOUTUBE, TIKTOK, THREADS, LINKEDIN, X_TWITTER, BLUESKY)'),
            content: z.string().optional().describe('Post text or caption'),
        },
    }, async (args) => {
        const platform = args.platform ? `for ${args.platform}` : '';
        const content = args.content ? `\nPost content: "${args.content}"` : '';
        return {
            messages: [{
                role: 'user',
                content: {
                    type: 'text',
                    text: `Help me schedule a social media post ${platform}.${content}

Steps:
1. Call list_accounts to find my connected accounts.
2. If the platform is FACEBOOK or TELEGRAM, call list_chats to get the publishing destination (Page or Channel).
3. If I need to attach media, call upload_media with the image/video URL first.
4. Call schedule_post with the account ID, platform, content, media keys (if any), and scheduled time.`,
                },
            }],
        };
    });

    return server;
}

// ─── Redis & EventStore ─────────────────────────────────────────────────────

const redis = new Redis(config.REDIS_URL, { family: 6 });
const eventStore = new RedisEventStore(redis);

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
    registration_endpoint: `${issuerUrl}oidc/register`,
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

// ─── Health Check ───────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.status(200).send('ok'));

// ─── Server Card (Smithery metadata discovery) ─────────────────────────────

app.get('/.well-known/mcp/server-card.json', (_req, res) => {
    res.json({
        serverInfo: {
            name: 'mcp-server-postpulse',
            version: '1.0.0',
        },
        authentication: {
            required: true,
            schemes: ['oauth2'],
        },
        configSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    });
});

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
            eventStore,
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
