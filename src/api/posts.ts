/** A post item as returned by `GET /v1/posts` (only the fields this server reads). */
export interface ApiPostListItem {
    id: number;
    content?: string;
    overallStatus: string;
    scheduledTime?: string;
    platforms?: string[];
}

/** A post as returned by `GET /v1/posts/{id}` (only the fields this server reads). */
export interface ApiPost {
    id: number;
    overallStatus: string;
    scheduledTime?: string;
    publications?: ApiPublication[];
}

interface ApiPublication {
    id: number;
    socialMediaAccountId: number;
    accountUsername?: string;
    platformName: string;
    status: string;
    posts?: ApiPublishedPost[];
}

interface ApiPublishedPost {
    id: number;
    chatId?: string;
    platformPostIdentifier?: string;
    permalink?: string;
    errorMessage?: string;
    content?: string;
    media?: Array<{ filename?: string; contentType?: string }>;
    metrics?: ApiMetrics;
}

interface ApiMetrics {
    impressions?: number;
    engagements?: number;
    likes?: number;
    shares?: number;
    comments?: number;
    profileClicks?: number;
    lastUpdatedTime?: string;
    // The platform's own fields, passed through as is: keys vary by platform and post type.
    platformAnalytics?: Record<string, unknown> | null;
}

/** Compact view of a post in a list: one row per post, across all its platforms. */
export interface PostSummary {
    id: number;
    status: string;
    scheduledTime?: string;
    platforms: string[];
    content?: string;
}

/**
 * A post with its outcome on each account. Media are summarised without their URLs: those are short-lived
 * presigned links of no use in a chat.
 */
export interface PostDetails {
    id: number;
    status: string;
    scheduledTime?: string;
    publications: Array<{
        accountId: number;
        platform: string;
        username?: string;
        status: string;
        posts: Array<{
            id: number;
            url?: string;
            platformPostId?: string;
            chatId?: string;
            content?: string;
            error?: string;
            media: Array<{ filename?: string; contentType?: string }>;
            metrics?: ApiMetrics;
        }>;
    }>;
}

export function toPostSummary(post: ApiPostListItem): PostSummary {
    return {
        id: post.id,
        status: post.overallStatus,
        scheduledTime: post.scheduledTime,
        platforms: post.platforms ?? [],
        content: post.content,
    };
}

export function toPostDetails(post: ApiPost): PostDetails {
    return {
        id: post.id,
        status: post.overallStatus,
        scheduledTime: post.scheduledTime,
        publications: (post.publications ?? []).map((pub) => ({
            accountId: pub.socialMediaAccountId,
            platform: pub.platformName,
            username: pub.accountUsername,
            status: pub.status,
            posts: (pub.posts ?? []).map((p) => ({
                id: p.id,
                url: p.permalink,
                platformPostId: p.platformPostIdentifier,
                chatId: p.chatId,
                content: p.content,
                error: p.errorMessage,
                media: (p.media ?? []).map((m) => ({ filename: m.filename, contentType: m.contentType })),
                metrics: p.metrics,
            })),
        })),
    };
}
