import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import { deletePostTool, handleDeletePost } from '../src/tools/delete_post';
import { deleteMediaTool, handleDeleteMedia } from '../src/tools/delete_media';

let calls: Array<{ url: string; params?: any }> = [];
let failure: { status: number; data: any } | null = null;

(clientModule as any).createApiClient = () => ({
    delete: async (url: string, config?: { params?: any }) => {
        calls.push({ url, params: config?.params });
        if (failure) {
            throw Object.assign(new Error(`Request failed with status code ${failure.status}`), { response: { data: failure.data } });
        }
        return { status: 204, data: '' };
    },
});

function reset() {
    calls = [];
    failure = null;
}

const tests: Array<[string, () => Promise<void>]> = [
    ['delete_post: the whole post, PostPulse only, says the post stays on the platforms', async () => {
        reset();
        const result: any = await handleDeletePost({ postId: 5 }, {});
        assert.deepEqual(calls, [{ url: '/v1/posts/5', params: { deleteFromPlatform: undefined } }]);
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /Post 5 deleted from PostPulse/);
        assert.match(result.content[0].text, /stays on the platforms/);
    }],
    ['delete_post: one publication', async () => {
        reset();
        const result: any = await handleDeletePost({ postId: 5, publicationId: 10 }, {});
        assert.equal(calls[0].url, '/v1/posts/5/accounts/10');
        assert.match(result.content[0].text, /Publication 10 of post 5 deleted from PostPulse/);
    }],
    ['delete_post: deleteFromPlatform reaches the API for the post and for one publication', async () => {
        reset();
        const whole: any = await handleDeletePost({ postId: 5, deleteFromPlatform: true }, {});
        await handleDeletePost({ postId: 5, publicationId: 10, deleteFromPlatform: true }, {});
        assert.deepEqual(calls, [
            { url: '/v1/posts/5', params: { deleteFromPlatform: true } },
            { url: '/v1/posts/5/accounts/10', params: { deleteFromPlatform: true } },
        ]);
        assert.match(whole.content[0].text, /also deleted on the platforms/);
    }],
    ['delete_post: refusals are tool errors with the code the description explains', async () => {
        for (const [status, code] of [
            [409, 'post_in_progress'],
            [400, 'platform_deletion_not_supported'],
            [502, 'platform_deletion_failed'],
        ] as Array<[number, string]>) {
            reset();
            failure = { status, data: { error: 'refused', code } };
            const result: any = await handleDeletePost({ postId: 5, deleteFromPlatform: true }, {});
            assert.equal(result.isError, true);
            assert.match(result.content[0].text, new RegExp(String(status)));
            assert.match(result.content[0].text, new RegExp(code));
            assert.match(deletePostTool.description, new RegExp(code));
        }
    }],
    ['delete_post schema: no id can turn into 0, and "false" never means true', async () => {
        const { inputSchema } = deletePostTool;
        assert.equal(inputSchema.safeParse({ postId: 0 }).success, false);
        assert.equal(inputSchema.safeParse({ postId: null }).success, false);
        assert.equal(inputSchema.safeParse({ postId: 5, publicationId: 0 }).success, false);
        assert.equal(inputSchema.safeParse({ postId: 5, publicationId: null }).success, false);
        assert.equal(inputSchema.safeParse({ postId: 5, deleteFromPlatform: 'false' }).success, false);
        assert.deepEqual(inputSchema.parse({ postId: '5' }), { postId: 5 });
    }],
    ['delete_media: the key from upload_media is addressed by its last segment', async () => {
        reset();
        const result: any = await handleDeleteMedia({ key: '6354d8d2-e0f1/e1992700.jpeg' }, {});
        assert.equal(calls[0].url, '/v1/media/e1992700.jpeg');
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /6354d8d2-e0f1\/e1992700\.jpeg deleted/);
    }],
    ['delete_media: a key without a prefix works as is', async () => {
        reset();
        await handleDeleteMedia({ key: 'e1992700.jpeg' }, {});
        assert.equal(calls[0].url, '/v1/media/e1992700.jpeg');
    }],
    ['delete_media: a crafted key cannot reach another endpoint', async () => {
        reset();
        await handleDeleteMedia({ key: '../posts/123' }, {});
        await handleDeleteMedia({ key: '../posts?a=1#b' }, {});
        assert.deepEqual(calls.map((c) => c.url), ['/v1/media/123', '/v1/media/posts%3Fa%3D1%23b']);
    }],
    ['delete_media: a file of a post being published is a tool error', async () => {
        reset();
        failure = { status: 409, data: { error: 'Post 5 is IN_PROGRESS; try again when it finishes', code: 'post_in_progress' } };
        const result: any = await handleDeleteMedia({ key: 'e1992700.jpeg' }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /post_in_progress/);
        assert.match(deleteMediaTool.description, /post_in_progress/);
    }],
    ['delete_media schema: an empty key is rejected', async () => {
        assert.equal(deleteMediaTool.inputSchema.safeParse({ key: '' }).success, false);
    }],
];

async function run() {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`ok - ${name}`);
        } catch (error) {
            failed++;
            console.error(`not ok - ${name}`);
            console.error(error);
        }
    }
    if (failed > 0) {
        process.exit(1);
    }
}

run();
