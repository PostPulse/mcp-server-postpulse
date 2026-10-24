import { z } from 'zod';
import { createApiClient } from '../api/client';
import { ApiPostListItem, toPostSummary } from '../api/posts';

/** The posts endpoint is not paginated, so a call is bounded by its date range instead. */
export const MAX_RANGE_DAYS = 93;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const POST_STATUSES = [
    'DRAFT', 'SCHEDULED', 'AWAITING_MEDIA', 'MEDIA_IMPORT_FAILED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'PARTIALLY_COMPLETED',
] as const;

export const listPostsTool = {
    name: 'list_posts',
    description: `List the user's posts scheduled or published in a date range (by scheduled time), oldest first: id, status, scheduled time, platforms and text. Use it for questions like "show my posts for October" or "what is scheduled next week". The range may span at most ${MAX_RANGE_DAYS} days; split longer periods into several calls. Drafts without a scheduled time are not listed. Call get_post with a post id for its per-platform status, public link (url), error and metrics.`,
    inputSchema: z.object({
        fromDate: z.string().describe('Start of the range: an ISO-8601 date (2026-10-01, start of that day UTC) or timestamp (2026-10-01T00:00:00Z)'),
        toDate: z.string().describe('End of the range: an ISO-8601 date (2026-10-31, end of that day UTC) or timestamp'),
        platform: z.string().optional().describe('Only posts to this platform, as list_accounts returns it (e.g. INSTAGRAM, TIKTOK, FACEBOOK_PAGE)'),
        status: z.enum(POST_STATUSES).optional().describe('Only posts with this overall status. COMPLETED = published everywhere, PARTIALLY_COMPLETED = published on some platforms'),
    }),
};

/** Reads an ISO date or timestamp; a bare date stands for the start (or, for an end bound, the end) of that UTC day. */
function parseBound(value: string, endOfDay: boolean): Date | null {
    if (DATE_ONLY.test(value)) {
        const date = new Date(`${value}T00:00:00.000Z`);
        return Number.isNaN(date.getTime()) ? null : new Date(date.getTime() + (endOfDay ? DAY_MS - 1 : 0));
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function errorResult(text: string) {
    return { content: [{ type: 'text' as const, text }], isError: true };
}

export async function handleListPosts(
    { fromDate, toDate, platform, status }: { fromDate: string; toDate: string; platform?: string; status?: string },
    extra: any,
) {
    const from = parseBound(fromDate, false);
    const to = parseBound(toDate, true);
    if (!from || !to) {
        return errorResult('Error: fromDate and toDate must be ISO-8601 dates (2026-10-01) or timestamps (2026-10-01T00:00:00Z).');
    }
    if (from > to) {
        return errorResult('Error: fromDate must not be after toDate.');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
        return errorResult(`Error: the range may span at most ${MAX_RANGE_DAYS} days. Split it into several list_posts calls.`);
    }

    const token = (extra as any)?.authInfo?.token || '';
    const clientId = (extra as any)?.authInfo?.clientId || '';
    const client = createApiClient(token, clientId);
    try {
        const response = await client.get<ApiPostListItem[]>('/v1/posts', {
            params: { fromDate: from.toISOString(), toDate: to.toISOString() },
        });
        const wantedPlatform = platform?.toUpperCase();
        const posts = response.data
            .map(toPostSummary)
            .filter((post) => !wantedPlatform || post.platforms.includes(wantedPlatform))
            .filter((post) => !status || post.status === status);
        const content = [{ type: 'text' as const, text: JSON.stringify(posts, null, 2) }];
        if (posts.length === 0) {
            content.push({ type: 'text' as const, text: 'No posts match this range and filters.' });
        }
        return { content };
    } catch (error: any) {
        return errorResult(`Error: ${error.message} ${error.response?.data ? JSON.stringify(error.response.data) : ''}`);
    }
}
