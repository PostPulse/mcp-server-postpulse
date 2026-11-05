# PostPulse MCP Server

[![smithery badge](https://smithery.ai/badge/post-pulse/mcp-server)](https://smithery.ai/servers/post-pulse/mcp-server)

An MCP (Model Context Protocol) server that connects AI assistants to [PostPulse](https://post-pulse.com) — a social media management platform. Schedule posts, upload media, and manage accounts across Instagram, Facebook, YouTube, TikTok, Threads, LinkedIn, Pinterest, X (Twitter), Bluesky, and Telegram — all through natural language.

## Features

- **Multi-platform posting** — Schedule posts to 10 social media platforms from a single interface
- **Media management** — Find files in the media library, import images and videos by URL, or upload small files as base64
- **Account management** — List and manage all connected social media accounts
- **Read your posts** — List posts by date range and get each post's per-platform status, public link, error and metrics
- **Delete posts and media** — Permanently delete a post or one account's publication of it, optionally on the social network too, and files from the media library
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
| **Pinterest** | Pin | Image, Video, Carousel (2–5 images) | Board |
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
| `POSTPULSE_AUTH_US_JWKS_URI` | `https://dev-yb150m5gz2ss41sl.us.auth0.com/.well-known/jwks.json` | JWKS of the US Auth0 tenant; empty turns the US key set off |
| `POSTPULSE_AUTH_US_ISSUERS` | value of `POSTPULSE_AUTH_ISSUER` | Comma-separated issuers trusted for US keys |
| `POSTPULSE_AUTH_EU_JWKS_URI` | — | JWKS of the EU Auth0 tenant; empty turns the EU key set off |
| `POSTPULSE_AUTH_EU_ISSUERS` | — | Comma-separated issuers trusted for EU keys |
| `POSTPULSE_AUDIENCE` | `https://api.post-pulse.com` | API audience |
| `POSTPULSE_API_URL` | `https://api.post-pulse.com` | PostPulse API base URL |
| `REDIS_URL` | — | Redis connection URL for session/event persistence (required) |

## Tools

### `list_accounts`

List all connected social media accounts with their IDs, platforms, usernames, and display names. Use this as the first step to discover available accounts before scheduling posts or accessing chats.

**Parameters:** None

**Returns:** JSON array of account objects (`id`, `platform`, `username`, `name`, `needsReauthorization`). A new user has no accounts yet: the result is `[]` plus a hint to use `connect_account`. Accounts with `needsReauthorization: true` must be reconnected with `connect_account` before posting; the result names them in a second text block.

### `connect_account`

Get a secure PostPulse link that connects (or reconnects) a social media account to PostPulse directly from the chat. The user opens the link in any browser and lands on a PostPulse page that shows which PostPulse account (masked email) the social account will be attached to. After **Continue** and approving access on the platform, the page says "Account connected — return to your chat". The tool does not wait for completion: once the user says they are done, call `list_accounts` to confirm the account.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `platform` | string | One of the two | `INSTAGRAM`, `FACEBOOK`, `YOUTUBE`, `TIKTOK`, `THREADS`, `LINKEDIN`, `X_TWITTER`, `BLUE_SKY`, `TELEGRAM`, `PINTEREST` |
| `accountId` | number | One of the two | Reconnect an existing account (from `list_accounts`, usually one with `needsReauthorization: true`). The platform is taken from the account |

**Behaviour:**
- For a new connection the tool first checks that the user may add an account (plan or credits). If not, it returns the reason and a link to billing.
- The link is single-use, tied to the user's PostPulse account and valid for **24 hours**; the platform consent starts only when the user clicks Continue on the page. It must not be shared: whoever completes it attaches their social account to this PostPulse account.
- If too many links are requested in a short time, the tool asks to wait a few minutes and try again.
- **Telegram** cannot be connected with a link: the tool returns instructions to connect it on https://post-pulse.com/app/accounts instead.
- A new Facebook connection creates one `FACEBOOK_PAGE` account per picked Page: post to it directly, without `list_chats`. For `TELEGRAM` and for a reconnected `FACEBOOK` account, call `list_chats` afterwards to pick the channel or Page.
- Clients that support URL-mode elicitation additionally get a native "open this link" dialog; the link is always in the text result as well.
- Errors that happen in the browser (account limit, account already used by another PostPulse user, expired link) are shown on the page, not returned by the tool.

### `list_chats`

List publishing destinations for accounts that have sub-destinations. Facebook accounts publish to **Pages**, Telegram accounts publish to **channels or chats**, and Pinterest accounts publish to **boards**. Call this before scheduling posts to these platforms — use the returned `id` as the `facebookPageId`, `telegramChannelId` or `pinterestBoardId` in `schedule_post`.

Only supports accounts whose platform is `FACEBOOK`, `TELEGRAM` or `PINTEREST`. Other platforms, including `FACEBOOK_PAGE` (an account that is one Page), do not have sub-destinations and should be posted to directly.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `accountId` | number | Yes | Account ID obtained from `list_accounts` |

**Returns:** JSON array of destination objects (`id`, `title`, `type`, `platform`).

### `upload_media`

Upload a media file for use in scheduled posts. Supports two modes: importing from a public URL (with automatic processing) or uploading a small file directly as base64. Returns a media key to reference in `schedule_post`.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `mediaUrl` | string | No | Public URL of the media file to import |
| `mediaData` | string | No | Base64-encoded content of a file up to about 75 KB |
| `mediaType` | string | No | MIME type (e.g., `image/jpeg`, `image/png`). Required when using `mediaData` |
| `mediaName` | string | No | File name with a media extension (e.g., `clip.mp4`). Needed with `mediaData`, and with `mediaUrl` when the URL does not end in such a name |
| `importId` | number | No | Id of an import reported as still running, to keep waiting for it |

One of `mediaUrl`, both `mediaData` and `mediaType`, or `importId` must be provided.

**Long imports:** a call waits about 50 seconds. An import that takes longer keeps running on the server, and the call returns its id and state instead of a media key. Call `upload_media` again with `importId` to keep waiting; do not start the import again.

**File size:** a request to this server is limited to 100 KB, and base64 data travels inside the request, so `mediaData` fits only files up to about 75 KB. A larger request gets a `413` with a JSON-RPC error that explains the options. For a larger file:

1. If it has a public URL, pass it in `mediaUrl`.
2. Otherwise upload it at https://post-pulse.com/app/gallery, then call `list_media`, find the file by its name and pass its key to `schedule_post`.

### `list_media`

List the files in the media library, newest first. Use it to find a file uploaded on the PostPulse website by its name and pass its key to `schedule_post`. A file uploaded with `mediaData` appears a few minutes later, but its key from `upload_media` works at once.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `page` | number | No | Page number, from 0. Default `0` |
| `size` | number | No | Files per page, 1-50. Default `20` |

**Returns:** a JSON object with `items` (`key`, `filename`, `contentType`, `sizeBytes`), `page`, `size`, `totalItems` and `totalPages`. An empty library also gets a hint with the gallery link.

### `schedule_post`

Schedule a social media post to one or more connected accounts. Supports platform-specific options like publication type (feed, reel, story), video titles, and topic tags. Posts are scheduled for a future time using ISO-8601 timestamps.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `accountId` | number | Yes | Account ID from `list_accounts` |
| `platform` | string | Yes | Target platform: `INSTAGRAM`, `FACEBOOK`, `TELEGRAM`, `YOUTUBE`, `TIKTOK`, `THREADS`, `LINKEDIN`, `PINTEREST`, `X_TWITTER`, `BLUE_SKY` |
| `content` | string | No | Post text/caption |
| `mediaPaths` | string[] | No | Media keys from `list_media` or `upload_media` |
| `scheduledTime` | string | Yes | ISO-8601 timestamp (e.g., `2025-01-15T10:00:00Z`) |
| `facebookPageId` | string | **Yes** (Facebook) | Facebook Page ID from `list_chats`. Required when platform is `FACEBOOK` |
| `telegramChannelId` | string | **Yes** (Telegram) | Telegram Channel/Chat ID from `list_chats`. Required when platform is `TELEGRAM` |
| `pinterestBoardId` | string | **Yes** (Pinterest) | Pinterest Board ID from `list_chats`. Required when platform is `PINTEREST` |
| `publicationType` | string | No | `FEED`, `REELS`, or `STORY` (Instagram/Facebook, defaults to `FEED`) |
| `title` | string | No | Video title (YouTube, TikTok) or Pin title (Pinterest, up to 100 characters) |
| `topicTag` | string | No | Topic tag (Threads) |
| `link` | string | No | Destination URL opened when the Pin is clicked (Pinterest) |
| `altText` | string | No | Alt text for the Pin image (Pinterest) |
| `boardSectionId` | string | No | Section within the board (Pinterest) |

### `list_posts`

List posts scheduled or published in a date range (by scheduled time), oldest first: id, overall status, scheduled time, platforms and text. The API is not paginated, so one call spans at most 93 days; split longer periods into several calls. Drafts without a scheduled time are not listed.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `fromDate` | string | Yes | ISO-8601 date (`2026-10-01`, start of that UTC day) or timestamp |
| `toDate` | string | Yes | ISO-8601 date (`2026-10-31`, end of that UTC day) or timestamp |
| `platform` | string | No | Only posts to this platform, as `list_accounts` returns it |
| `status` | string | No | `DRAFT`, `SCHEDULED`, `AWAITING_MEDIA`, `MEDIA_IMPORT_FAILED`, `IN_PROGRESS`, `COMPLETED`, `FAILED` or `PARTIALLY_COMPLETED` |

### `get_post`

Get one post with its outcome on each account: `publicationId` (for `delete_post`), platform, status, public link to the published post (`url`), platform post id, error message, text, attached media (`key` for `delete_media`, file name and type) and the latest metrics PostPulse has:

- `impressions`, `engagements`, `likes`, `shares`, `comments` and `profileClicks`, common to all platforms. A metric the platform does not report is `null`;
- `lastUpdatedTime`;
- `platformAnalytics`: the platform's own analytics for the post under the platform's field names, e.g. `view_count` on TikTok or `views` and `quotes` on Threads. Its fields depend on the platform and the post type, so do not expect a fixed set. It is `null` when the platform reports none.

Metrics of published posts are refreshed from the platform on each call.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `postId` | number | Yes | Post id from `list_posts` or `schedule_post` |

### `delete_post`

Permanently delete a post from PostPulse with its results and metrics, in any status. This cannot be undone, so the tool is marked destructive and its description tells the agent to get the user's confirmation first. Media files stay in the library (see `delete_media`).

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `postId` | number | Yes | Post id from `list_posts`, `get_post` or `schedule_post` |
| `publicationId` | number | No | Delete only this account's publication (`publicationId` in `get_post`). Deleting the last one deletes the whole post |
| `deleteFromPlatform` | boolean | No | Also delete the published post on the social network. Default `false`: what is published stays there |

**Refusals** (nothing is deleted in PostPulse):
- `post_in_progress`: the post is being published or, for one publication, its media is still being imported. Try again when that finishes.
- `platform_deletion_not_supported`: `deleteFromPlatform` is strict, and these `platforms` cannot delete the post. No platform was called.
- `platform_deletion_failed`: a platform call failed. Posts already removed from other platforms stay removed, and retrying is safe.

Which platforms support `deleteFromPlatform` is listed in the [API documentation](https://post-pulse.com/api-docs).

### `delete_media`

Permanently delete a file from the media library and storage. A post that is not published yet is deleted on the accounts where it is left without the media the platform requires or without any content; a published or failed post stays and only loses the attachment. What is already published stays on the social network. If a post using the file is being published, the tool returns `post_in_progress` and nothing is deleted.

**Parameters:**
| Name | Type | Required | Description |
|---|---|---|---|
| `key` | string | Yes | Media key from `list_media`, `upload_media` or `media[].key` in `get_post`, not the file name |

## Resources

### `postpulse://accounts`

An MCP resource providing the list of all connected social media accounts. Returns the same data as the `list_accounts` tool in JSON format, including `needsReauthorization`.

## Authentication

This server uses OAuth 2.0 with [Auth0](https://auth0.com). OAuth metadata is discoverable at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.

No existing PostPulse account is needed: signing in through the MCP client (with Google or a passwordless email code) creates the PostPulse account on first use. The user then connects social accounts with `connect_account`.

### Dynamic Client Registration (DCR)

MCP clients that support OAuth can register automatically via **Dynamic Client Registration** (RFC 7591). The server advertises a `registration_endpoint` in its OAuth metadata, so compliant clients (such as Claude Desktop, Cursor, etc.) will handle the entire OAuth flow — registration, authorization, and token exchange — without any manual setup from the user.

### Pre-Registered Client Credentials

If you already have client credentials created through the [PostPulse Developer Portal](https://post-pulse.com/app/portal/apps), you can configure your MCP client to use them directly instead of DCR. Pass your `client_id` and `client_secret` in the OAuth authorization code flow against the PostPulse authorization server.

## HTTP Endpoints

| Path | Purpose |
|---|---|
| `POST /`, `POST /sse` | MCP Streamable HTTP transport (initialize + messages), Bearer token required. The body is parsed only after the token check and is limited to 100 KB; a larger one gets `413` with a JSON-RPC error |
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
3. **Get a media key** (optional): find a file with `list_media`, or import one by URL with `upload_media`
4. **Schedule a post** with content, media, and a future publish time

```
User: "Schedule an Instagram reel for tomorrow at 9am with the video at https://example.com/video.mp4 and caption 'Check this out!'"
```

### A video without a public URL

A video is too large for `mediaData`, so it goes through the media library:

```
User:      "Post my new reel to Instagram tomorrow at 9:00 UTC. The file is on my computer."
Assistant: "Please upload the video at https://post-pulse.com/app/gallery and tell me the file name."
User:      "Done, it's reel-42.mp4"
Assistant: list_media → { items: [{ key: "<user>/<id>.mp4", filename: "reel-42.mp4", ... }], ... }
           schedule_post(accountId: 123, platform: INSTAGRAM, mediaPaths: ["<user>/<id>.mp4"], publicationType: REELS, scheduledTime: ...)
```

### First run (new user)

```
User:      "Post 'Hello LinkedIn!' to my LinkedIn tomorrow at 10:00 UTC"
Assistant: list_accounts → [] ("No social accounts are connected yet")
           connect_account(platform: LINKEDIN) → link
           "Open this link, check the PostPulse account on the page, approve access on LinkedIn, then tell me when you are done."
User:      "Done"
Assistant: list_accounts → [{ id: 123, platform: LINKEDIN, ... }]
           schedule_post(accountId: 123, platform: LINKEDIN, content: "Hello LinkedIn!", scheduledTime: ...)
```