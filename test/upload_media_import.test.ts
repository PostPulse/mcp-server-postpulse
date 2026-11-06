import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import { logger } from '../src/logger';
import { handleUploadMedia, IMPORT_WAIT_MS, uploadMediaTool } from '../src/tools/upload_media';

const SIGNED_URL = 'https://files.example.com/a?signature=secret-signature';

// Polls wait 2 s between status reads; run them immediately and move a fake clock instead.
let now = 0;
(globalThis as any).setTimeout = (fn: () => void, ms = 0) => { now += ms; fn(); return 0; };
Date.now = () => now;

let states: any[] = [];
let reads = 0;
let posts: Array<{ url: string; body: any; options: any }> = [];
let readUrls: string[] = [];
let readTimes: number[] = [];
let readOptions: any[] = [];
let readError: any;
let postError: any;
let logLines: any[] = [];

(logger as any).info = (fields: any) => logLines.push(fields);
(clientModule as any).createApiClient = () => ({
    post: async (url: string, body: any, options: any) => {
        posts.push({ url, body, options });
        if (postError) throw postError;
        return { data: { id: 7 } };
    },
    get: async (url: string, options: any) => {
        readUrls.push(url);
        readTimes.push(now);
        readOptions.push(options);
        if (readError) throw readError;
        return { data: states[Math.min(reads++, states.length - 1)] };
    },
});

function reset(next: any[]) {
    states = next;
    reads = 0;
    posts = [];
    readUrls = [];
    readTimes = [];
    readOptions = [];
    readError = undefined;
    postError = undefined;
    logLines = [];
    now = 1_000_000;
}

function httpError(status: number, data: any) {
    return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

const tests: Array<[string, () => Promise<void>]> = [
    ['upload_media: FAILED_TEMPORARY is retried by the backend, so polling continues until READY', async () => {
        reset([{ state: 'FAILED_TEMPORARY', errorCode: 'TIMEOUT' }, { state: 'DOWNLOADING' }, { state: 'READY', s3Key: 'u/a.mp4' }]);
        const result: any = await handleUploadMedia({ mediaUrl: 'https://example.com/a.mp4' }, {});
        assert.equal(result.isError, undefined);
        assert.equal(result.content[0].text, 'u/a.mp4');
        assert.equal(reads, 3);
    }],
    ['upload_media: FAILED_PERMANENT ends polling with the error detail', async () => {
        reset([{ state: 'FAILED_PERMANENT', errorCode: 'UNSUPPORTED_MIME' }]);
        const result: any = await handleUploadMedia({ mediaUrl: 'https://example.com/a.txt' }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /FAILED_PERMANENT.*UNSUPPORTED_MIME/);
        assert.doesNotMatch(result.content[0].text, /importId/);
    }],
    ['mediaName goes to the import as filenameHint', async () => {
        reset([{ state: 'READY', s3Key: 'u/a.mp4' }]);
        await handleUploadMedia({ mediaUrl: SIGNED_URL, mediaName: 'clip.mp4' }, {});
        assert.deepEqual(posts[0].body, { url: SIGNED_URL, filenameHint: 'clip.mp4' });
    }],
    ['without mediaName no filenameHint is sent', async () => {
        reset([{ state: 'READY', s3Key: 'u/a.mp4' }]);
        await handleUploadMedia({ mediaUrl: SIGNED_URL }, {});
        assert.deepEqual(posts[0].body, { url: SIGNED_URL });
    }],
    ['an import still running at the deadline is not an error: the result has its id and state', async () => {
        reset([{ state: 'DOWNLOADING', sourceUrl: SIGNED_URL }]);
        const start = now;
        const result: any = await handleUploadMedia({ mediaUrl: SIGNED_URL }, {});
        assert.equal(result.isError, undefined);
        const text = result.content[0].text;
        assert.match(text, /still running/);
        assert.match(text, /DOWNLOADING/);
        assert.match(text, /importId 7/);
        assert.match(text, /do not start the import again/);
        assert.doesNotMatch(text, /signature/);
        assert.equal(now - start, IMPORT_WAIT_MS);
        assert.equal(reads, IMPORT_WAIT_MS / 2000);
    }],
    ['FAILED_TEMPORARY at the deadline also counts as running', async () => {
        reset([{ state: 'FAILED_TEMPORARY', errorCode: 'TIMEOUT' }]);
        const result: any = await handleUploadMedia({ mediaUrl: SIGNED_URL }, {});
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /still running.*FAILED_TEMPORARY/);
    }],
    ['still running: one log line with the outcome, the id and no URL', async () => {
        reset([{ state: 'UPLOADING', totalBytes: 5000, sourceUrl: SIGNED_URL }]);
        await handleUploadMedia({ mediaUrl: SIGNED_URL }, {});
        assert.equal(logLines.length, 1);
        assert.equal(logLines[0].outcome, 'still_running');
        assert.equal(logLines[0].importId, 7);
        assert.equal(logLines[0].state, 'UPLOADING');
        assert.equal(logLines[0].sizeBytes, 5000);
        assert.doesNotMatch(JSON.stringify(logLines[0]), /signature|files\.example\.com/);
    }],
    ['importId continues a running import: no new import, and the first read is at once', async () => {
        reset([{ state: 'VALIDATING' }, { state: 'READY', s3Key: 'u/a.mp4' }]);
        const start = now;
        const result: any = await handleUploadMedia({ importId: 42 }, {});
        assert.equal(result.isError, undefined);
        assert.equal(result.content[0].text, 'u/a.mp4');
        assert.deepEqual(posts, []);
        assert.equal(readUrls[0], '/v1/media/upload/import/42');
        assert.equal(readTimes[0], start);
        assert.equal(logLines[0].mode, 'check');
        assert.equal(logLines[0].importId, 42);
        assert.equal(logLines[0].outcome, 'ok');
    }],
    ['importId wins over mediaUrl, so a repeated call cannot start a second import', async () => {
        reset([{ state: 'READY', s3Key: 'u/a.mp4' }]);
        await handleUploadMedia({ importId: 42, mediaUrl: SIGNED_URL }, {});
        assert.deepEqual(posts, []);
        assert.equal(readUrls[0], '/v1/media/upload/import/42');
    }],
    ['a check can also stop at the deadline', async () => {
        reset([{ state: 'DOWNLOADING' }]);
        const result: any = await handleUploadMedia({ importId: 42 }, {});
        assert.equal(result.isError, undefined);
        assert.match(result.content[0].text, /importId 42/);
    }],
    ['a read with no answer does not call the import failed: the error points to importId', async () => {
        reset([]);
        readError = Object.assign(new Error('timeout of 50000ms exceeded'), { code: 'ECONNABORTED' });
        const result: any = await handleUploadMedia({ mediaUrl: SIGNED_URL }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /importId 7/);
        assert.match(result.content[0].text, /do not start it again/);
    }],
    ['a 5xx on a read points to importId too', async () => {
        reset([]);
        readError = httpError(502, { message: 'Bad Gateway' });
        const result: any = await handleUploadMedia({ mediaUrl: SIGNED_URL }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /importId 7/);
    }],
    ['a 400 on a check is a final answer: no pointer back to the same importId', async () => {
        reset([]);
        readError = httpError(400, { error: 'Media import task not found for id 42' });
        const result: any = await handleUploadMedia({ importId: 42 }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /not found/);
        assert.doesNotMatch(result.content[0].text, /may still be running/);
    }],
    ['a refused import gets the answer of this tool, whatever the API says', async () => {
        for (const data of [
            { error: `filenameHint is required when a valid media filename cannot be derived from the URL: ${SIGNED_URL}` },
            { error: 'a text the API has not used yet' },
            { error: 'size must be between 0 and 4096' },
            '',
        ]) {
            reset([]);
            postError = httpError(400, data);
            const result: any = await handleUploadMedia({ mediaUrl: SIGNED_URL, mediaName: 'photo' }, {});
            const text = result.content[0].text;
            assert.equal(result.isError, true);
            assert.match(text, /mediaName must be a file name with a media extension/);
            assert.match(text, /the URL itself was refused/);
            assert.doesNotMatch(text, /filenameHint|secret-signature|has not used|size must/);
            assert.doesNotMatch(text, /may still be running/);
            assert.equal(reads, 0);
        }
    }],
    ['a refused import is logged with its status and no text of the API', async () => {
        reset([]);
        postError = httpError(400, { error: `refused: ${SIGNED_URL}` });
        await handleUploadMedia({ mediaUrl: SIGNED_URL }, {});
        assert.equal(logLines.length, 1);
        assert.equal(logLines[0].outcome, 'failed');
        assert.equal(logLines[0].status, 400);
        assert.doesNotMatch(JSON.stringify(logLines[0]), /secret-signature|refused/);
    }],
    ['other failures of the import request keep the answer of the API', async () => {
        reset([]);
        postError = httpError(403, { error: 'Not allowed on this plan' });
        const result: any = await handleUploadMedia({ mediaUrl: SIGNED_URL, mediaName: 'a.mp4' }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /Not allowed on this plan/);
        assert.doesNotMatch(result.content[0].text, /mediaName must/);
    }],
    ['a 400 on a status read is about the import, so it keeps the answer of the API', async () => {
        reset([]);
        readError = httpError(400, { error: 'Media import task not found for id 7' });
        const result: any = await handleUploadMedia({ mediaUrl: SIGNED_URL, mediaName: 'a.mp4' }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /not found/);
        assert.doesNotMatch(result.content[0].text, /mediaName must/);
    }],
    ['every API call is bounded by the deadline, and a read near it still gets a moment', async () => {
        reset([{ state: 'DOWNLOADING' }]);
        await handleUploadMedia({ mediaUrl: SIGNED_URL }, {});
        assert.equal(posts[0].options.timeout, IMPORT_WAIT_MS);
        assert.ok(readOptions[0].timeout <= IMPORT_WAIT_MS);
        for (const options of readOptions) {
            assert.ok(options.timeout >= 2000);
        }
        assert.equal(readOptions.at(-1).timeout, 2000);
    }],
    ['an unknown state ends the wait with an error, not an empty media key', async () => {
        reset([{ state: 'ARCHIVED' }]);
        const result: any = await handleUploadMedia({ mediaUrl: SIGNED_URL }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /unexpected state: ARCHIVED/);
        assert.doesNotMatch(result.content[0].text, /importId/);
    }],
    ['READY without a key is an error too', async () => {
        reset([{ state: 'READY' }]);
        const result: any = await handleUploadMedia({ mediaUrl: SIGNED_URL }, {});
        assert.equal(result.isError, true);
    }],
    ['schema: importId takes a number, a numeric string or null, and refuses zero', async () => {
        const { inputSchema } = uploadMediaTool;
        assert.equal(inputSchema.parse({ importId: 42 }).importId, 42);
        assert.equal(inputSchema.parse({ importId: '42' }).importId, 42);
        assert.equal(inputSchema.parse({ importId: null }).importId, null);
        assert.equal(inputSchema.safeParse({ importId: 0 }).success, false);
    }],
    ['texts: long imports and the file name rule', async () => {
        const { description, inputSchema } = uploadMediaTool;
        assert.match(description, /importId/);
        assert.match(description, /do not start the import again/);
        assert.match(inputSchema.shape.mediaName.description ?? '', /media extension/);
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
