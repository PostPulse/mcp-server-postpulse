import './setup_env';
import assert from 'node:assert/strict';
import axios from 'axios';
import * as clientModule from '../src/api/client';
import { logger } from '../src/logger';
import { handleUploadMedia, uploadMediaTool } from '../src/tools/upload_media';

const SIGNED_URL = 'https://files.example.com/video.mp4?signature=secret-signature';
const SIGNED_UPLOAD_URL = 'https://storage.example.com/put?signature=secret-put-signature';
const DATA = Buffer.from('small image content').toString('base64');
const EXTRA = { authInfo: { token: 'tok', clientId: 'client-1', extra: { sub: 'auth0|user-1' } } };

let logLines: any[] = [];
let post: (url: string, body: any) => any;
let get: (url: string) => any;
let put: () => any;

(logger as any).info = (fields: any, message: string) => logLines.push({ ...fields, message });
(clientModule as any).createApiClient = () => ({
    post: async (url: string, body: any) => post(url, body),
    get: async (url: string) => get(url),
});
(axios as any).put = async () => put();

function httpError(status: number, data: any) {
    return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

function reset() {
    logLines = [];
    post = (url) => {
        if (url === '/v1/media/upload/import') return { data: { id: 42 } };
        return { data: { url: SIGNED_UPLOAD_URL, key: 'user-1/key.png', headers: {} } };
    };
    get = () => ({ data: { state: 'READY', s3Key: 'user-1/imported.mp4', sourceUrl: SIGNED_URL, totalBytes: 5000 } });
    put = () => ({ status: 200 });
}

/** One line per call, and none of the secrets or file content in it. */
function onlyLine() {
    assert.equal(logLines.length, 1);
    const text = JSON.stringify(logLines[0]);
    assert.doesNotMatch(text, /signature/);
    assert.doesNotMatch(text, /files\.example\.com/);
    assert.ok(!text.includes(DATA));
    assert.equal(logLines[0].message, 'upload_media finished');
    return logLines[0];
}

const tests: Array<[string, () => Promise<void>]> = [
    ['url mode: one log line with the mode, size and outcome, and no URL', async () => {
        const result: any = await handleUploadMedia({ mediaUrl: SIGNED_URL }, EXTRA);
        assert.equal(result.content[0].text, 'user-1/imported.mp4');
        const line = onlyLine();
        assert.equal(line.tool, 'upload_media');
        assert.equal(line.mode, 'url');
        assert.equal(line.sizeBytes, 5000);
        assert.equal(line.state, 'READY');
        assert.equal(line.outcome, 'ok');
        assert.equal(line.clientId, 'client-1');
        assert.equal(line.sub, 'auth0|user-1');
    }],
    ['url mode: a failed import echoing the signed URL is not logged with it', async () => {
        get = () => ({ data: { state: 'FAILED_PERMANENT', errorCode: 'SOURCE_ERROR', errorMessage: `Cannot fetch ${SIGNED_URL}` } });
        const result: any = await handleUploadMedia({ mediaUrl: SIGNED_URL }, EXTRA);
        assert.equal(result.isError, true);
        const line = onlyLine();
        assert.equal(line.mode, 'url');
        assert.equal(line.state, 'FAILED_PERMANENT');
        assert.equal(line.outcome, 'failed');
    }],
    ['url mode: a rejected import logs the status only', async () => {
        post = () => { throw httpError(400, { error: `Bad source ${SIGNED_URL}` }); };
        const result: any = await handleUploadMedia({ mediaUrl: SIGNED_URL }, EXTRA);
        assert.equal(result.isError, true);
        const line = onlyLine();
        assert.equal(line.status, 400);
        assert.equal(line.outcome, 'failed');
    }],
    ['base64 mode: the log has the decoded size and no data', async () => {
        const result: any = await handleUploadMedia({ mediaData: DATA, mediaType: 'image/png' }, EXTRA);
        assert.equal(result.content[0].text, 'user-1/key.png');
        const line = onlyLine();
        assert.equal(line.mode, 'base64');
        assert.equal(line.sizeBytes, Buffer.from(DATA, 'base64').length);
        assert.equal(line.outcome, 'ok');
    }],
    ['base64 mode: a failed upload to storage is logged without the upload URL', async () => {
        put = () => { throw httpError(403, `<Error>${SIGNED_UPLOAD_URL}</Error>`); };
        const result: any = await handleUploadMedia({ mediaData: DATA, mediaType: 'image/png' }, EXTRA);
        assert.equal(result.isError, true);
        const line = onlyLine();
        assert.equal(line.status, 403);
        assert.equal(line.outcome, 'failed');
    }],
    ['no file at all: logged as invalid input', async () => {
        const result: any = await handleUploadMedia({ mediaType: 'image/png' }, EXTRA);
        assert.equal(result.isError, true);
        const line = onlyLine();
        assert.equal(line.mode, 'none');
        assert.equal(line.outcome, 'invalid_input');
    }],
    ['texts: base64 states its limit and sends larger files to mediaUrl or the gallery', async () => {
        const { description, inputSchema } = uploadMediaTool;
        assert.match(description, /about 75 KB/);
        assert.match(description, /Never try mediaData for a video/);
        assert.match(description, /mediaUrl/);
        assert.match(description, /https:\/\/post-pulse\.com\/app\/gallery/);
        assert.match(description, /list_media/);
        assert.match(description, /Do not ask the user to shrink/);
        assert.match(inputSchema.shape.mediaData.description ?? '', /about 75 KB/);
        assert.doesNotMatch(inputSchema.shape.mediaType.description ?? '', /video/);
    }],
];

async function run() {
    let failed = 0;
    for (const [name, fn] of tests) {
        reset();
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
