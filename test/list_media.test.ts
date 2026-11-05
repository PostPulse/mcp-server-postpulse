import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import { listMediaTool, handleListMedia } from '../src/tools/list_media';

let calls: Array<{ url: string; params?: any }> = [];
let response: any;
let failure: { status: number; data: any } | null = null;

(clientModule as any).createApiClient = () => ({
    get: async (url: string, config?: { params?: any }) => {
        calls.push({ url, params: config?.params });
        if (failure) {
            throw Object.assign(new Error(`Request failed with status code ${failure.status}`), { response: { data: failure.data } });
        }
        return { data: response };
    },
});

const PAGE = {
    items: [{
        key: 'e1992700.mp4',
        path: '6354d8d2-e0f1/e1992700.mp4',
        url: 'https://storage/presigned-file',
        thumbnailUrl: 'https://storage/presigned-thumbnail',
        filename: 'Reel — Instagram.mp4',
        contentType: 'video/mp4',
        sizeBytes: 101000000,
    }],
    page: 2,
    size: 5,
    totalItems: 11,
    totalPages: 3,
};

function reset() {
    calls = [];
    response = PAGE;
    failure = null;
}

const tests: Array<[string, () => Promise<void>]> = [
    ['the key is the API\'s path, the one schedule_post needs, and presigned URLs stay out', async () => {
        reset();
        const result: any = await handleListMedia({ page: 2, size: 5 }, {});
        assert.deepEqual(calls, [{ url: '/v1/media', params: { page: 2, size: 5 } }]);
        assert.equal(result.isError, undefined);
        assert.deepEqual(JSON.parse(result.content[0].text), {
            items: [{ key: '6354d8d2-e0f1/e1992700.mp4', filename: 'Reel — Instagram.mp4', contentType: 'video/mp4', sizeBytes: 101000000 }],
            page: 2,
            size: 5,
            totalItems: 11,
            totalPages: 3,
        });
        assert.doesNotMatch(result.content[0].text, /presigned/);
        assert.equal(result.content.length, 1);
    }],
    ['paging defaults to the first page of 20, also when a client sends null', async () => {
        reset();
        await handleListMedia({}, {});
        await handleListMedia(listMediaTool.inputSchema.parse({ page: null, size: null }), {});
        assert.deepEqual(calls.map((c) => c.params), [{ page: 0, size: 20 }, { page: 0, size: 20 }]);
    }],
    ['an empty library adds a hint with the gallery', async () => {
        reset();
        response = { items: [], page: 0, size: 20, totalItems: 0, totalPages: 0 };
        const result: any = await handleListMedia({}, {});
        assert.deepEqual(JSON.parse(result.content[0].text).items, []);
        assert.match(result.content[1].text, /https:\/\/post-pulse\.com\/app\/gallery/);
    }],
    ['a page past the end is not called an empty library', async () => {
        reset();
        response = { items: [], page: 9, size: 20, totalItems: 11, totalPages: 1 };
        const result: any = await handleListMedia({ page: 9 }, {});
        assert.equal(result.content.length, 1);
    }],
    ['API errors are surfaced as tool errors', async () => {
        reset();
        failure = { status: 403, data: { error: 'Forbidden' } };
        const result: any = await handleListMedia({}, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /403/);
        assert.match(result.content[0].text, /Forbidden/);
    }],
    ['schema: the page size is capped, and numbers may come as strings', async () => {
        const { inputSchema } = listMediaTool;
        assert.equal(inputSchema.safeParse({ size: 51 }).success, false);
        assert.equal(inputSchema.safeParse({ size: 0 }).success, false);
        assert.equal(inputSchema.safeParse({ page: -1 }).success, false);
        assert.equal(inputSchema.safeParse({ page: 1.5 }).success, false);
        assert.deepEqual(inputSchema.parse({ page: '3', size: '50' }), { page: 3, size: 50 });
        assert.deepEqual(inputSchema.parse({}), {});
    }],
];

async function run() {
    let failed = 0;
    for (const [name, fn] of tests) {
        try {
            await fn();
            console.log(`ok - ${name}`);
        } catch (error: any) {
            failed++;
            console.error(`not ok - ${name}\n   ${error.message}`);
        }
    }
    console.log(`\n${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
}

run();
