import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import { editPostTool, handleEditPost } from '../src/tools/edit_post';

let calls: Array<{ method: string; url: string; body?: any }> = [];
let posts: Record<string, any> = {};
let patchFailure: { status: number; data: any } | null = null;

function httpError(status: number, data: any) {
    return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

(clientModule as any).createApiClient = () => ({
    get: async (url: string) => {
        calls.push({ method: 'GET', url });
        if (url in posts) return { data: posts[url] };
        throw httpError(404, { error: 'Posting schedule not found' });
    },
    patch: async (url: string, body: any) => {
        calls.push({ method: 'PATCH', url, body });
        if (patchFailure) throw httpError(patchFailure.status, patchFailure.data);
        return { data: patched };
    },
});

// One item: a scheduled Instagram reel with a cover.
const single = {
    id: 5,
    overallStatus: 'SCHEDULED',
    scheduledTime: '2026-11-20T10:00:00Z',
    publications: [{
        id: 50, socialMediaAccountId: 7, accountUsername: 'jane', platformName: 'INSTAGRAM', status: 'SCHEDULED',
        posts: [{ id: 500, content: 'Old text', media: [{ path: 'user-1/a.mp4' }], thumbnail: { path: 'user-1/cover.jpg' } }],
    }],
};

// Three items: Instagram, and a Telegram publication to two chats, one of them with no text and no media.
const several = {
    id: 6,
    overallStatus: 'SCHEDULED',
    scheduledTime: '2026-11-20T10:00:00Z',
    publications: [
        {
            id: 60, socialMediaAccountId: 7, accountUsername: 'jane', platformName: 'INSTAGRAM', status: 'SCHEDULED',
            posts: [{ id: 600, content: 'Instagram text written for this platform only, long enough to be cut in the list of items', media: [] }],
        },
        {
            id: 61, socialMediaAccountId: 9, platformName: 'TELEGRAM', status: 'SCHEDULED',
            posts: [
                { id: 610, chatId: '-1001', content: 'Telegram text', media: [{ path: 'user-1/t.jpg' }] },
                { id: 611, chatId: '-1002', media: [] },
            ],
        },
    ],
};

// What the API answers to a PATCH: the post after the edit.
const patched = {
    id: 5,
    overallStatus: 'SCHEDULED',
    scheduledTime: '2026-11-21T12:00:00Z',
    pendingImports: [],
    publications: [{
        id: 50, socialMediaAccountId: 7, accountUsername: 'jane', platformName: 'INSTAGRAM', status: 'SCHEDULED',
        platformSettingsNew: { publicationType: 'REELS' },
        posts: [{
            id: 500, content: 'New text',
            media: [{ key: 'b.mp4', path: 'user-1/b.mp4', url: 'https://s3/presigned', filename: 'b.mp4', contentType: 'video/mp4' }],
            thumbnail: { key: 'cover2.jpg', path: 'user-1/cover2.jpg', url: 'https://s3/presigned-cover' },
        }],
    }],
};

function reset() {
    calls = [];
    patchFailure = null;
    posts = { '/v1/posts/5': single, '/v1/posts/6': several };
}

function patchCalls() {
    return calls.filter((c) => c.method === 'PATCH');
}

function textOf(result: any): string {
    return result.content[0].text;
}

const tests: Array<[string, () => Promise<void>]> = [
    ['the post is read, then the PATCH carries exactly the given fields under the API names', async () => {
        reset();
        await handleEditPost({
            postId: 6,
            changes: [
                { postEntryId: 600, content: 'New Instagram text', clearContent: false },
                { postEntryId: 610, mediaPaths: ['user-1/x.jpg', 'user-1/y.jpg'], thumbnailPath: 'user-1/c.jpg', removeMedia: false },
                { postEntryId: 611, clearContent: true, removeMedia: true },
            ],
        }, {});
        assert.deepEqual(calls, [
            { method: 'GET', url: '/v1/posts/6' },
            {
                method: 'PATCH',
                url: '/v1/posts/6',
                body: {
                    posts: [
                        { id: 600, content: 'New Instagram text' },
                        { id: 610, attachmentPaths: ['user-1/x.jpg', 'user-1/y.jpg'], thumbnailPath: 'user-1/c.jpg' },
                        { id: 611, clearContent: true, removeAttachments: true },
                    ],
                },
            },
        ]);
    }],
    ['a time alone is sent as a UTC instant, without posts', async () => {
        reset();
        await handleEditPost({ postId: 6, scheduledTime: '2026-11-21T14:00:00+02:00' }, {});
        assert.deepEqual(patchCalls(), [{ method: 'PATCH', url: '/v1/posts/6', body: { scheduledTime: '2026-11-21T12:00:00.000Z' } }]);
    }],
    ['an empty or blank content never erases the text and points to clearContent', async () => {
        reset();
        for (const content of ['', '   ', '\n']) {
            const result: any = await handleEditPost({ postId: 5, changes: [{ content }] }, {});
            assert.equal(result.isError, true);
            assert.match(textOf(result), /changes\[0\]\.content is empty/);
            assert.match(textOf(result), /clearContent: true/);
        }
        assert.equal(calls.length, 0);
    }],
    ['an empty mediaPaths never removes the media and points to removeMedia', async () => {
        reset();
        const result: any = await handleEditPost({ postId: 5, scheduledTime: '2026-11-21T12:00:00Z', changes: [{ mediaPaths: [] }] }, {});
        assert.equal(result.isError, true);
        assert.match(textOf(result), /changes\[0\]\.mediaPaths is empty/);
        assert.match(textOf(result), /removeMedia: true/);
        assert.equal(calls.length, 0);
    }],
    ['a value together with its removing flag, and a cover with removeMedia, are refused', async () => {
        reset();
        const both: Array<[any, RegExp]> = [
            [{ content: 'a', clearContent: true }, /both content and clearContent/],
            [{ mediaPaths: ['user-1/x.jpg'], removeMedia: true }, /both mediaPaths and removeMedia/],
            [{ removeMedia: true, thumbnailPath: 'user-1/c.jpg' }, /removeMedia and thumbnailPath/],
        ];
        for (const [change, message] of both) {
            const result: any = await handleEditPost({ postId: 5, changes: [change] }, {});
            assert.equal(result.isError, true);
            assert.match(textOf(result), message);
        }
        assert.equal(calls.length, 0);
    }],
    ['an empty input, and changes with nothing or only false flags, are refused without calling the API', async () => {
        reset();
        const nothing: any = await handleEditPost({ postId: 5 }, {});
        const noChanges: any = await handleEditPost({ postId: 5, changes: [] }, {});
        const idOnly: any = await handleEditPost({ postId: 5, scheduledTime: '2026-11-21T12:00:00Z', changes: [{ postEntryId: 500 }] }, {});
        const falseFlags: any = await handleEditPost({ postId: 5, changes: [{ clearContent: false, removeMedia: false }] }, {});
        for (const result of [nothing, noChanges, idOnly, falseFlags]) {
            assert.equal(result.isError, true);
        }
        assert.match(textOf(nothing), /nothing to change/);
        assert.match(textOf(idOnly), /changes\[0\] has no content/);
        assert.match(textOf(falseFlags), /changes\[0\] has no content/);
        assert.equal(calls.length, 0);
    }],
    ['a change without postEntryId on a post with one item goes to that item', async () => {
        reset();
        await handleEditPost({ postId: 5, scheduledTime: '2026-11-21T12:00:00Z', changes: [{ content: 'New text' }] }, {});
        assert.deepEqual(patchCalls()[0].body, { scheduledTime: '2026-11-21T12:00:00.000Z', posts: [{ id: 500, content: 'New text' }] });
    }],
    ['a change without postEntryId on a post with several items lists them and sends no PATCH', async () => {
        reset();
        const result: any = await handleEditPost({ postId: 6, changes: [{ content: 'Same text everywhere' }] }, {});
        assert.equal(result.isError, true);
        assert.equal(patchCalls().length, 0);
        const text = textOf(result);
        assert.match(text, /3 items/);
        assert.match(text, /Nothing was changed/);
        assert.match(text, /postEntryId 600: INSTAGRAM @jane \(accountId 7\), text "Instagram text written/);
        assert.match(text, /\.\.\."/);
        assert.match(text, /postEntryId 610: TELEGRAM \(accountId 9\), chat -1001, text "Telegram text"/);
        assert.match(text, /postEntryId 611: TELEGRAM \(accountId 9\), chat -1002$/m);
    }],
    ['a postEntryId that is not in the post lists the items and sends no PATCH', async () => {
        reset();
        const result: any = await handleEditPost({ postId: 6, changes: [{ postEntryId: 6, content: 'a' }] }, {});
        assert.equal(result.isError, true);
        assert.match(textOf(result), /no item with postEntryId 6\b/);
        assert.match(textOf(result), /postEntryId 611/);
        assert.equal(patchCalls().length, 0);
    }],
    ['two changes for one item never reach PATCH, also when both lack postEntryId', async () => {
        reset();
        const given: any = await handleEditPost({ postId: 6, changes: [{ postEntryId: 600, content: 'a' }, { postEntryId: 600, thumbnailPath: 'user-1/c.jpg' }] }, {});
        const filled: any = await handleEditPost({ postId: 5, changes: [{ content: 'a' }, { removeMedia: true }] }, {});
        assert.equal(given.isError, true);
        assert.equal(filled.isError, true);
        assert.match(textOf(filled), /more than one change for postEntryId 500/);
        assert.equal(patchCalls().length, 0);
    }],
    ['a GET error is a tool error and nothing is sent', async () => {
        reset();
        const result: any = await handleEditPost({ postId: 404, changes: [{ postEntryId: 1, content: 'a' }] }, {});
        assert.equal(result.isError, true);
        assert.match(textOf(result), /404/);
        assert.equal(patchCalls().length, 0);
    }],
    ['a time without an offset, a date and a non-time never reach the API', async () => {
        reset();
        for (const scheduledTime of ['2026-11-21T12:00:00', '2026-11-21', 'tomorrow 12:00', '2026-13-45T12:00:00Z', '']) {
            const result: any = await handleEditPost({ postId: 5, scheduledTime }, {});
            assert.equal(result.isError, true, scheduledTime);
            assert.match(textOf(result), /Z or an offset/);
        }
        assert.equal(calls.length, 0);
    }],
    ['an API error reaches the agent as readable text', async () => {
        reset();
        patchFailure = { status: 400, data: { error: 'The text of post 500 is set by its platform; leave content out' } };
        const result: any = await handleEditPost({ postId: 5, changes: [{ postEntryId: 500, content: 'x' }] }, {});
        assert.equal(result.isError, true);
        assert.match(textOf(result), /400/);
        assert.match(textOf(result), /set by its platform/);
    }],
    ['the result is the post as get_post shows it and the previous values of what changed', async () => {
        reset();
        const result: any = await handleEditPost({
            postId: 5,
            scheduledTime: '2026-11-21T12:00:00Z',
            changes: [{ content: 'New text', mediaPaths: ['user-1/b.mp4'], thumbnailPath: 'user-1/cover2.jpg' }],
        }, {});
        assert.equal(result.isError, undefined);
        assert.deepEqual(JSON.parse(textOf(result)), {
            post: {
                id: 5,
                status: 'SCHEDULED',
                scheduledTime: '2026-11-21T12:00:00Z',
                publications: [{
                    publicationId: 50, accountId: 7, platform: 'INSTAGRAM', username: 'jane', status: 'SCHEDULED',
                    posts: [{
                        id: 500, content: 'New text',
                        media: [{ key: 'user-1/b.mp4', filename: 'b.mp4', contentType: 'video/mp4' }],
                        thumbnail: 'user-1/cover2.jpg',
                    }],
                }],
            },
            before: {
                scheduledTime: '2026-11-20T10:00:00Z',
                changes: [{ postEntryId: 500, content: 'Old text', mediaPaths: ['user-1/a.mp4'], thumbnailPath: 'user-1/cover.jpg' }],
            },
        });
        assert.doesNotMatch(textOf(result), /presigned/);
    }],
    ['before covers only what changed: a media change keeps the old cover, an empty item restores by flags', async () => {
        reset();
        const textOnly: any = await handleEditPost({ postId: 5, changes: [{ content: 'New text' }] }, {});
        assert.deepEqual(JSON.parse(textOf(textOnly)).before, { changes: [{ postEntryId: 500, content: 'Old text' }] });

        const mediaOnly: any = await handleEditPost({ postId: 5, changes: [{ removeMedia: true }] }, {});
        assert.deepEqual(JSON.parse(textOf(mediaOnly)).before, {
            changes: [{ postEntryId: 500, mediaPaths: ['user-1/a.mp4'], thumbnailPath: 'user-1/cover.jpg' }],
        });

        // 611 had no text and no media; 600 had no cover, and no input takes a cover off alone.
        const fromEmpty: any = await handleEditPost({
            postId: 6,
            changes: [
                { postEntryId: 611, content: 'Now with text', mediaPaths: ['user-1/n.jpg'] },
                { postEntryId: 600, thumbnailPath: 'user-1/c.jpg' },
            ],
        }, {});
        assert.deepEqual(JSON.parse(textOf(fromEmpty)).before, {
            changes: [{ postEntryId: 611, clearContent: true, removeMedia: true }],
        });
    }],
    ['before passes back as edit_post input and restores the previous values', async () => {
        reset();
        const edited: any = await handleEditPost({
            postId: 5,
            scheduledTime: '2026-11-21T12:00:00Z',
            changes: [{ content: 'New text', removeMedia: true }],
        }, {});
        const { before } = JSON.parse(textOf(edited));
        const input = editPostTool.inputSchema.parse({ postId: 5, ...before });
        calls = [];
        const restored: any = await handleEditPost(input, {});
        assert.equal(restored.isError, undefined);
        assert.deepEqual(patchCalls()[0].body, {
            scheduledTime: '2026-11-20T10:00:00.000Z',
            posts: [{ id: 500, content: 'Old text', attachmentPaths: ['user-1/a.mp4'], thumbnailPath: 'user-1/cover.jpg' }],
        });
    }],
    ['schema: ids cannot turn into 0, flags are not coerced, an empty key is rejected', async () => {
        const { inputSchema } = editPostTool;
        assert.equal(inputSchema.safeParse({ postId: 0 }).success, false);
        assert.equal(inputSchema.safeParse({ postId: null }).success, false);
        assert.equal(inputSchema.safeParse({ postId: 5, changes: [{ postEntryId: 0, content: 'a' }] }).success, false);
        assert.equal(inputSchema.safeParse({ postId: 5, changes: [{ postEntryId: null, content: 'a' }] }).success, false);
        assert.equal(inputSchema.safeParse({ postId: 5, changes: [{ clearContent: 'false' }] }).success, false);
        assert.equal(inputSchema.safeParse({ postId: 5, changes: [{ removeMedia: 'false' }] }).success, false);
        assert.equal(inputSchema.safeParse({ postId: 5, changes: [{ mediaPaths: [''] }] }).success, false);
        assert.equal(inputSchema.safeParse({ postId: 5, changes: [{ thumbnailPath: '' }] }).success, false);
        assert.deepEqual(inputSchema.parse({ postId: '5', changes: [{ postEntryId: '500', removeMedia: true }] }), {
            postId: 5, changes: [{ postEntryId: 500, removeMedia: true }],
        });
    }],
];

async function run() {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`ok - edit_post: ${name}`);
        } catch (error) {
            failed++;
            console.error(`not ok - edit_post: ${name}`);
            console.error(error);
        }
    }
    if (failed > 0) {
        process.exit(1);
    }
}

run();
