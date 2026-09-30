# PostPulse MCP Server

[![smithery badge](https://smithery.ai/badge/post-pulse/mcp-server)](https://smithery.ai/servers/post-pulse/mcp-server)

An MCP (Model Context Protocol) server that connects AI assistants to [PostPulse](https://post-pulse.com) — a social media management platform. Schedule posts, upload media, and manage accounts across Instagram, Facebook, YouTube, TikTok, Threads, LinkedIn, X (Twitter), Bluesky, and Telegram — all through natural language.

## Features

- **Multi-platform posting** — Schedule posts to 9 social media platforms from a single interface
- **Media management** — Upload images and videos via URL or binary data for use in posts
- **Account management** — List and manage all connected social media accounts
- **Connect social accounts from the chat** — Get a secure link to connect or reconnect an account without opening the PostPulse app
- **OAuth 2.0 authentication** — Secure access via Auth0-based token verification
- **Streamable HTTP transport** — Modern MCP transport protocol for reliable communication

## Supported Platforms

| Platform | Placements | Content Types | Requirements |
| :--- | :--- | :--- | :--- |
| **Instagram** | Feed, Reels, Stories | Image, Video | Business Account |
| **Facebook** | Feed, Reels, Stories | Image, Video | Page |
| **YouTube** | Video, Shorts | Video | Channel |
| **TikTok** | Video, Carousel | Image, Video | Account |
| **Threads** | Post | Image, Video | Account |
| **LinkedIn** | Post | Image, Video | Personal Account |
| **X (Twitter)** | Post | Image, Video | Account |
| **Bluesky** | Post | Image | Account |
| **Telegram** | Message | Text, Image, Video | Channel/Chat |

## Quick Start

### Hosted Server (Recommended)

PostPulse runs a hosted MCP server at **`https://mcp.post-pulse.com`** — no setup required. Point your MCP client to this URL and authenticate via OAuth.

Example MCP client configuration:

```json
{
  "mcpServers": {
    "postpulse": {
      "url": "https://mcp.post-pulse.com"
    }
  }
}
```

### Install via Smithery

You can also install through [Smithery](https://smithery.ai/servers/post-pulse/mcp-server):

```bash
npx -y @smithery/cli install post-pulse/mcp-server --client claude
```

### Self-Hosted

If you prefer to run the server yourself:

1. Clone the repository:
```bash
git clone https://github.com/PostPulse/mcp-server-postpulse.git
cd mcp-server-postpulse
```

2. Install dependencies and build:
```bash
npm install
npm run build
```

3. Start the server:
```bash
npm start
```

Or with Docker:

```bash
docker build -t mcp-server-postpulse .
docker run -p 3000:3000 mcp-server-postpulse
```

#### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HOST` | `0.0.0.0` | Server bind address |
| `PORT` | `3000` | Server port |
| `PUBLIC_URL` | — | Public-facing URL (for OAuth metadata discovery) |
| `POSTPULSE_AUTH_ISSUER` | `https://auth.post-pulse.com/` | Auth0 issuer URL |
| `POSTPULSE_AUTH_JWKS_URI` | `https://auth.post-pulse.com/.well-known/jwks.json` | JWKS endpoint |
| `POSTPULSE_AUDIENCE` | `https://api.post-pulse.com` | API audience |
| `POSTPULSE_API_URL` | `https://api.post-pulse.com` | PostPulse API base URL |
| `REDIS_URL` | — | Redis connection URL for session/event persistence (required) |

## Tools

### `list_accounts`

List all connected social media accounts with their IDs, platforms, usernames, and display names. Use this as the first step to discover available accounts before scheduling posts or accessing chats.

**Parameters:** None

**Returns:** JSON array of account objects (`id`, `platform`, `username`, `name`, `needsReauthorization`). A new user has no accounts yet: the result is `[]` plus a hint to use `connect_account`. Accounts with `needsReauthorization: true` must be reconnected with `connect_account` before posting; the result names them in a second text block.

### `connect_account`

Get a secure link that connects (or reconnects) a social media account to PostPulse directly from the chat. The user opens the link in any browser, approves access on the platform and sees "Account connected". The tool does not wait for completion: once the user says they are done, call `list_accounts` to confirm the account.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `platform` | string | One of the two | `INSTAGRAM`, `FACEBOOK`, `YOUTUBE`, `TIKTOK`, `THREADS`, `LINKEDIN`, `X_TWITTER`, `BLUE_SKY`, `TELEGRAM` |
| `accountId` | number | One of the two | Reconnect an existing account (from `list_accounts`, usually one with `needsReauthorization: true`). The platform is taken from the account |

**Behaviour:**
- For a new connection the tool first checks that the user may add an account (plan or credits). If not, it returns the reason and a link to billing.
- The link is single-use, tied to the user's PostPulse account and valid for **2 hours** (Bluesky: about **5 minutes**). It must not be shared: whoever completes it attaches their social account to this PostPulse account.
- **Telegram** cannot be connected with a link: the tool returns instructions to connect it on https://post-pulse.com/app/accounts instead.
- For Facebook and Telegram, call `list_chats` afterwards to pick the Page or channel.
- Clients that support URL-mode elicitation additionally get a native "open this link" dialog; the link is always in the text result as well.
- Errors that happen in the browser (account limit, account already used by another PostPulse user, expired link) are shown on the page, not returned by the tool.

### `list_chats`

List publishing destinations for accounts that have sub-destinations. Facebook accounts publish to **Pages**, and Telegram accounts publish to **channels or chats**. Call this before scheduling posts to either platform — use the returned `id` as the `facebookPageId` or `telegramChannelId` in `schedule_post`.

Only supports `FACEBOOK` and `TELEGRAM`. Other platforms do not have sub-destinations and should be posted to directly.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `accountId` | number | Yes | Account ID obtained from `list_accounts` |
| `platform` | string | Yes | `FACEBOOK` or `TELEGRAM` |

**Returns:** JSON array of destination objects (`id`, `title`, `type`, `platform`).

### `upload_media`

Upload media files (images, videos) for use in scheduled posts. Supports two modes: importing from a public URL (with automatic processing) or uploading binary data directly as base64. Returns a media key to reference in `schedule_post`.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `mediaUrl` | string | No | Public URL of the media file to import |
| `mediaData` | string | No | Base64-encoded media file content |
| `mediaType` | string | No | MIME type (e.g., `image/jpeg`, `video/mp4`). Required when using `mediaData` |
| `mediaName` | string | No | Filename for the uploaded media |

Either `mediaUrl` or both `mediaData` and `mediaType` must be provided.

### `schedule_post`

Schedule a social media post to one or more connected accounts. Supports platform-specific options like publication type (feed, reel, story), video titles, and topic tags. Posts are scheduled for a future time using ISO-8601 timestamps.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `accountId` | number | Yes | Account ID from `list_accounts` |
| `platform` | string | Yes | Target platform: `INSTAGRAM`, `FACEBOOK`, `TELEGRAM`, `YOUTUBE`, `TIKTOK`, `THREADS`, `LINKEDIN`, `X_TWITTER`, `BLUE_SKY` |
| `content` | string | No | Post text/caption |
| `mediaPaths` | string[] | No | Media keys returned by `upload_media` |
| `scheduledTime` | string | Yes | ISO-8601 timestamp (e.g., `2025-01-15T10:00:00Z`) |
| `facebookPageId` | string | **Yes** (Facebook) | Facebook Page ID from `list_chats`. Required when platform is `FACEBOOK` |
| `telegramChannelId` | string | **Yes** (Telegram) | Telegram Channel/Chat ID from `list_chats`. Required when platform is `TELEGRAM` |
| `publicationType` | string | No | `FEED`, `REEL`, or `STORY` (Instagram/Facebook, defaults to `FEED`) |
| `title` | string | No | Video title (YouTube, TikTok) |
| `topicTag` | string | No | Topic tag (Threads) |

## Resources

### `postpulse://accounts`

An MCP resource providing the list of all connected social media accounts. Returns the same data as the `list_accounts` tool in JSON format, including `needsReauthorization`.

## Authentication

This server uses OAuth 2.0 with [Auth0](https://auth0.com). OAuth metadata is discoverable at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.

No existing PostPulse account is needed: signing in through the MCP client (with Google or a passwordless email code) creates the PostPulse account on first use. The user then connects social accounts with `connect_account`.

### Dynamic Client Registration (DCR)

MCP clients that support OAuth can register automatically via **Dynamic Client Registration** (RFC 7591). The server advertises a `registration_endpoint` in its OAuth metadata, so compliant clients (such as Claude Desktop, Cursor, etc.) will handle the entire OAuth flow — registration, authorization, and token exchange — without any manual setup from the user.

### Pre-Registered Client Credentials

If you already have client credentials created through the [PostPulse Developer Portal](https://developers.post-pulse.com), you can configure your MCP client to use them directly instead of DCR. Pass your `client_id` and `client_secret` in the OAuth authorization code flow against the PostPulse authorization server.

## HTTP Endpoints

| Path | Purpose |
|---|---|
| `POST /`, `POST /sse` | MCP Streamable HTTP transport (initialize + messages), Bearer token required |
| `GET /`, `GET /sse` with `Mcp-Session-Id` | SSE stream for an existing session |
| `GET /`, `GET /sse` with `Accept: text/html` | Minimal landing page for browsers and crawlers (links to the setup guide and API docs). Any other `Accept` without a session still gets `400` |
| `GET /health` | Health check (`ok`) |
| `GET /robots.txt` | `User-agent: * / Disallow: /` — the host is not a website |
| `GET /.well-known/*` | OAuth metadata and the Smithery server card |
| anything else | `404` (`{"error":"Not found"}` or plain text for HTML clients) |

Every response carries `X-Robots-Tag: noindex, nofollow` so search engines never index this host.

## Example Workflow

A typical interaction with the PostPulse MCP server:

1. **List accounts** to find connected social media profiles
2. **Connect an account** (if the platform is missing) with `connect_account`
3. **Upload media** (optional) to prepare images or videos
4. **Schedule a post** with content, media, and a future publish time

```
User: "Schedule an Instagram reel for tomorrow at 9am with the video at https://example.com/video.mp4 and caption 'Check this out!'"
```

### First run (new user)

```
User:      "Post 'Hello LinkedIn!' to my LinkedIn tomorrow at 10:00 UTC"
Assistant: list_accounts → [] ("No social accounts are connected yet")
           connect_account(platform: LINKEDIN) → link
           "Open this link and approve access on LinkedIn, then tell me when you are done."
User:      "Done"
Assistant: list_accounts → [{ id: 123, platform: LINKEDIN, ... }]
           schedule_post(accountId: 123, platform: LINKEDIN, content: "Hello LinkedIn!", scheduledTime: ...)
```