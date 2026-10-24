import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import { handleListPosts } from '../src/tools/list_posts';
import { handleGetPost } from '../src/tools/get_post';

let calls: Array<{ url: string; params?: any }> = [];
let responses: Record<string, any> = {};

(clientModule as any).createApiClient = () => ({
    get: async (url: string, config?: { params?: any }) => {
        calls.push({ url, params: config?.params });
        if (url in responses) return { data: responses[url] };
        throw Object.assign(new Error('Request failed with status code 404'), { response: { data: { message: 'Not found' } } });
    },
});

const listed = [
    { id: 1, content: 'Reel one', overallStatus: 'COMPLETED', scheduledTime: '2026-10-02T09:00:00Z', platforms: ['INSTAGRAM'], coverImageUrl: 'https://s3/presigned' },
    { id: 2, content: 'Both', overallStatus: 'PARTIALLY_COMPLETED', scheduledTime: '2026-10-05T09:00:00Z', platforms: ['INSTAGRAM', 'TIKTOK'] },
    { id: 3, content: 'Next', overallStatus: 'SCHEDULED', scheduledTime: '2026-10-30T09:00:00Z', platforms: ['TIKTOK'] },
];

function reset() {
    calls = [];
    responses = { '/v1/posts': listed };
}

const tests: Array<[string, () => Promise<void>]> = [
    ['list_posts: a bare date range covers whole UTC days and drops presigned cover URLs', async () => {
        reset();
        const result: any = await handleListPosts({ fromDate: '2026-10-01', toDate: '2026-10-31' }, {});
        assert.deepEqual(calls, [{ url: '/v1/posts', params: { fromDate: '2026-10-01T00:00:00.000Z', toDate: '2026-10-31T23:59:59.999Z' } }]);
        const posts = JSON.parse(result.content[0].text);
        assert.equal(posts.length, 3);
        assert.deepEqual(posts[0], { id: 1, status: 'COMPLETED', scheduledTime: '2026-10-02T09:00:00Z', platforms: ['INSTAGRAM'], content: 'Reel one' });
    }],
    ['list_posts: platform (any case) and status filters', async () => {
        reset();
        const byPlatform: any = await handleListPosts({ fromDate: '2026-10-01', toDate: '2026-10-31', platform: 'tiktok' }, {});
        assert.deepEqual(JSON.parse(byPlatform.content[0].text).map((p: any) => p.id), [2, 3]);
        const byStatus: any = await handleListPosts({ fromDate: '2026-10-01', toDate: '2026-10-31', status: 'COMPLETED' }, {});
        assert.deepEqual(JSON.parse(byStatus.content[0].text).map((p: any) => p.id), [1]);
    }],
    ['list_posts: no match adds a hint', async () => {
        reset();
        const result: any = await handleListPosts({ fromDate: '2026-10-01', toDate: '2026-10-31', platform: 'LINKEDIN' }, {});
        assert.deepEqual(JSON.parse(result.content[0].text), []);
        assert.match(result.content[1].text, /No posts match/);
    }],
    ['list_posts: timestamps are passed through as instants', async () => {
        reset();
        await handleListPosts({ fromDate: '2026-10-01T10:00:00+02:00', toDate: '2026-10-02T10:00:00Z' }, {});
        assert.deepEqual(calls[0].params, { fromDate: '2026-10-01T08:00:00.000Z', toDate: '2026-10-02T10:00:00.000Z' });
    }],
    ['list_posts: invalid, reversed and too long ranges are rejected without calling the API', async () => {
        reset();
        const invalid: any = await handleListPosts({ fromDate: 'October', toDate: '2026-10-31' }, {});
        assert.equal(invalid.isError, true);
        const reversed: any = await handleListPosts({ fromDate: '2026-10-31', toDate: '2026-10-01' }, {});
        assert.equal(reversed.isError, true);
        const tooLong: any = await handleListPosts({ fromDate: '2026-01-01', toDate: '2026-12-31' }, {});
        assert.equal(tooLong.isError, true);
        assert.match(tooLong.content[0].text, /93 days/);
        assert.equal(calls.length, 0);
    }],
    ['list_posts: a full quarter fits the range limit', async () => {
        reset();
        const result: any = await handleListPosts({ fromDate: '2026-07-01', toDate: '2026-09-30' }, {});
        assert.equal(result.isError, undefined);
    }],
    ['get_post: per-account outcome with url, error and metrics; media without URLs', async () => {
        reset();
        responses['/v1/posts/2'] = {
            id: 2,
            overallStatus: 'PARTIALLY_COMPLETED',
            scheduledTime: '2026-10-05T09:00:00Z',
            publications: [
                {
                    id: 10, socialMediaAccountId: 7, accountUsername: 'jane', platformName: 'INSTAGRAM', status: 'COMPLETED',
                    posts: [{
                        id: 100, platformPostIdentifier: '1790', permalink: 'https://www.instagram.com/reel/DAbC/', content: 'Both',
                        media: [{ key: 'a.mp4', url: 'https://s3/presigned', filename: 'a.mp4', contentType: 'video/mp4' }],
                        metrics: { likes: 12, comments: 3, shares: 1, lastUpdatedTime: '2026-10-24T10:00:00Z' },
                    }],
                },
                {
                    id: 11, socialMediaAccountId: 8, accountUsername: 'jane_tt', platformName: 'TIKTOK', status: 'FAILED',
                    posts: [{ id: 101, errorMessage: 'Video too short', content: 'Both', media: [] }],
                },
            ],
        };
        const result: any = await handleGetPost({ postId: 2 }, {});
        const post = JSON.parse(result.content[0].text);
        assert.equal(post.status, 'PARTIALLY_COMPLETED');
        assert.deepEqual(post.publications[0], {
            accountId: 7, platform: 'INSTAGRAM', username: 'jane', status: 'COMPLETED',
            posts: [{
                id: 100, url: 'https://www.instagram.com/reel/DAbC/', platformPostId: '1790', content: 'Both',
                media: [{ filename: 'a.mp4', contentType: 'video/mp4' }],
                metrics: { likes: 12, comments: 3, shares: 1, lastUpdatedTime: '2026-10-24T10:00:00Z' },
            }],
        });
        assert.equal(post.publications[1].posts[0].error, 'Video too short');
        assert.doesNotMatch(result.content[0].text, /presigned/);
    }],
    ['get_post: API errors are surfaced as tool errors', async () => {
        reset();
        const result: any = await handleGetPost({ postId: 999 }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /404/);
    }],
];

async function run() {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`✅ ${name}`);
        } catch (error: any) {
            failed++;
            console.error(`❌ ${name}\n   ${error.message}`);
        }
    }
    console.log(`\n${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
}

run();
