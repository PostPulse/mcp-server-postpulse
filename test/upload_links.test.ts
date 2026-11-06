import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import { logger } from '../src/logger';
import {
    createUploadLinkTool,
    getUploadLinkTool,
    handleCreateUploadLink,
    handleGetUploadLink,
} from '../src/tools/upload_links';

const LINK_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SECRET = 'secret-link-token';
const LINK_URL = `https://post-pulse.com/app/media-upload#${SECRET}`;
const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';
const EXTRA = { authInfo: { token: 'tok', clientId: 'client-1', extra: { sub: 'auth0|user-1' } } };

const FILE = {
    path: '6354d8d2-e0f1/e1992700.mp4',
    filename: 'Reel — Instagram.mp4',
    contentType: 'video/mp4',
    sizeBytes: 101000000,
    status: 'CONFIRMED',
};

let calls: Array<{ method: string; url: string; body?: any }> = [];
let logLines: any[] = [];
let post: () => any;
let get: () => any;

(logger as any).info = (fields: any, message: string) => logLines.push({ ...fields, message });
(clientModule as any).createApiClient = () => ({
    post: async (url: string, body?: any) => {
        calls.push({ method: 'POST', url, body });
        return post();
    },
    get: async (url: string) => {
        calls.push({ method: 'GET', url });
        return get();
    },
});

function httpError(status: number, data: any = { error: 'backend text' }) {
    return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

function reset() {
    calls = [];
    logLines = [];
    post = () => ({ data: { id: LINK_ID, url: LINK_URL, expiresAt: FUTURE } });
    get = () => ({ data: { expiresAt: FUTURE, files: [FILE] } });
}

const text = (result: any) => result.content.map((c: any) => c.text).join('\n');

/** One line per call, attributed to the caller, and with no secret in it. */
function onlyLine(tool: string) {
    assert.equal(logLines.length, 1);
    const line = logLines[0];
    assert.doesNotMatch(JSON.stringify(line), new RegExp(`${SECRET}|media-upload`));
    assert.equal(line.tool, tool);
    assert.equal(line.clientId, 'client-1');
    assert.equal(line.sub, 'auth0|user-1');
    assert.equal(line.message, `${tool} finished`);
    return line;
}

const tests: Array<[string, () => Promise<void>]> = [
    ['create: the result has the link, its expiry, the warning and the uploadLinkId', async () => {
        // The texts below are pinned on purpose: for a model they are the behaviour of this tool.
        reset();
        const result: any = await handleCreateUploadLink({}, EXTRA);
        assert.equal(result.isError, undefined);
        assert.deepEqual(calls, [{ method: 'POST', url: '/v1/media/upload-links', body: undefined }]);
        assert.ok(text(result).includes(`[Upload files to PostPulse](${LINK_URL})`));
        assert.ok(text(result).includes(FUTURE));
        assert.match(text(result), /whoever has this link can add files/);
        assert.match(text(result), /no login/);
        assert.ok(text(result).includes(`uploadLinkId: ${LINK_ID}`));
        assert.match(text(result), /get_upload_link/);
    }],
    ['create: showing the link is for a person who adds the files, and nothing orders the agent to wait', async () => {
        reset();
        const result: any = await handleCreateUploadLink({}, EXTRA);
        assert.match(result.content[0].text, /For a person opening this link:/);
        const forAgent = result.content[1].text;
        assert.match(forAgent, /A person who is to add the files needs the link in full, including the part after #/);
        assert.doesNotMatch(forAgent, /^Show the user|do not poll|Then wait/im);
    }],
    ['create: the description states the page as a fact and orders nothing', async () => {
        const { description } = createUploadLinkTool;
        assert.match(description, /plain HTTPS page with no login: whoever can open it, a person or an agent with a browser or HTTP access, can add files/);
        assert.doesNotMatch(description, /Show the link|and wait\b|from their device/i);
    }],
    ['create: the nanoseconds of the API\'s expiry stay out of the text for the user', async () => {
        reset();
        post = () => ({ data: { id: LINK_ID, url: LINK_URL, expiresAt: '2026-11-05T16:22:41.600141667Z' } });
        const result: any = await handleCreateUploadLink({}, EXTRA);
        assert.match(text(result), /until 2026-11-05T16:22:41Z\./);
    }],
    ['create: the log has the id but neither the link nor the token', async () => {
        reset();
        await handleCreateUploadLink({}, EXTRA);
        const line = onlyLine('create_upload_link');
        assert.equal(line.outcome, 'link_issued');
        assert.equal(line.uploadLinkId, LINK_ID);
    }],
    ['create: an answer without the link or the id is an error, because the flow cannot finish', async () => {
        for (const data of [{ id: LINK_ID, expiresAt: FUTURE }, { url: LINK_URL, expiresAt: FUTURE }, { id: LINK_ID, url: LINK_URL }, {}, undefined]) {
            reset();
            post = () => ({ data });
            const result: any = await handleCreateUploadLink({}, EXTRA);
            assert.equal(result.isError, true);
            assert.match(text(result), /did not return an upload link/);
            assert.ok(!text(result).includes(SECRET));
            assert.equal(onlyLine('create_upload_link').outcome, 'empty_link');
        }
    }],
    ['create: 401 asks to reconnect, 429 asks to wait, others surface the API error', async () => {
        const expected: Array<[number, RegExp]> = [
            [401, /session has expired/],
            [429, /too many upload links.*Wait/],
            [500, /status code 500.*backend text/],
        ];
        for (const [status, message] of expected) {
            reset();
            post = () => { throw httpError(status); };
            const result: any = await handleCreateUploadLink({}, EXTRA);
            assert.equal(result.isError, true);
            assert.match(text(result), message);
            const line = onlyLine('create_upload_link');
            assert.equal(line.outcome, 'failed');
            assert.equal(line.status, status);
        }
    }],
    ['create: a network error has no status and is still logged once', async () => {
        reset();
        post = () => { throw new Error('socket hang up'); };
        const result: any = await handleCreateUploadLink({}, EXTRA);
        assert.equal(result.isError, true);
        assert.match(text(result), /socket hang up/);
        assert.equal(onlyLine('create_upload_link').status, undefined);
    }],
    ['get: the key is the API\'s path, and only the known fields pass', async () => {
        reset();
        get = () => ({ data: { expiresAt: FUTURE, secret: 'x', files: [{ ...FILE, key: 'e1992700.mp4', url: 'https://storage/presigned' }] } });
        const result: any = await handleGetUploadLink({ uploadLinkId: LINK_ID }, EXTRA);
        assert.equal(result.isError, undefined);
        assert.deepEqual(calls, [{ method: 'GET', url: `/v1/media/upload-links/${LINK_ID}` }]);
        assert.deepEqual(JSON.parse(result.content[0].text), {
            expiresAt: FUTURE,
            files: [{
                key: '6354d8d2-e0f1/e1992700.mp4',
                filename: 'Reel — Instagram.mp4',
                contentType: 'video/mp4',
                sizeBytes: 101000000,
                status: 'CONFIRMED',
            }],
        });
        assert.doesNotMatch(result.content[0].text, /presigned/);
    }],
    ['get: the log has the id and the count, not the file names', async () => {
        reset();
        await handleGetUploadLink({ uploadLinkId: LINK_ID }, EXTRA);
        const line = onlyLine('get_upload_link');
        assert.equal(line.outcome, 'ok');
        assert.equal(line.uploadLinkId, LINK_ID);
        assert.equal(line.files, 1);
        assert.doesNotMatch(JSON.stringify(line), /Reel|e1992700/);
    }],
    ['get: with files, names are confirmed only when someone else added them', async () => {
        reset();
        const guidance = ((await handleGetUploadLink({ uploadLinkId: LINK_ID }, EXTRA)) as any).content[1].text;
        assert.match(guidance, /If someone else added these files, first show them the file names and ask them to confirm/);
        assert.match(guidance, /Files you added yourself need no confirmation/);
        assert.match(guidance, /mediaPaths/);
        assert.doesNotMatch(guidance, /PENDING file|REJECTED file|expired/);
    }],
    ['get: the description makes the confirmation conditional too', async () => {
        const { description } = getUploadLinkTool;
        assert.match(description, /If someone else added the files/);
        assert.match(description, /Files you added yourself need no confirmation/);
        assert.doesNotMatch(description, /not in a loop|once the user says/i);
    }],
    ['get: PENDING waits and REJECTED is not usable, each said only when present', async () => {
        reset();
        get = () => ({ data: { expiresAt: FUTURE, files: [FILE, { ...FILE, status: 'PENDING' }] } });
        let guidance = ((await handleGetUploadLink({ uploadLinkId: LINK_ID }, EXTRA)) as any).content[1].text;
        assert.match(guidance, /PENDING file may still be finishing/);
        assert.doesNotMatch(guidance, /REJECTED file/);

        get = () => ({ data: { expiresAt: FUTURE, files: [FILE, { ...FILE, status: 'REJECTED' }] } });
        guidance = ((await handleGetUploadLink({ uploadLinkId: LINK_ID }, EXTRA)) as any).content[1].text;
        assert.match(guidance, /REJECTED file was refused and cannot be used/);
        assert.doesNotMatch(guidance, /PENDING file/);
    }],
    ['get: an empty list says nothing has arrived, and does not assume a person is uploading', async () => {
        reset();
        get = () => ({ data: { expiresAt: FUTURE, files: [] } });
        const result: any = await handleGetUploadLink({ uploadLinkId: LINK_ID }, EXTRA);
        assert.equal(result.isError, undefined);
        assert.deepEqual(JSON.parse(result.content[0].text).files, []);
        assert.match(result.content[1].text, /No files have arrived through this link yet/);
        assert.doesNotMatch(result.content[1].text, /Do not poll|has not finished/);
        assert.doesNotMatch(result.content[1].text, /create_upload_link/);
    }],
    ['get: an expired link points to a new one, and its files stay usable', async () => {
        reset();
        get = () => ({ data: { expiresAt: PAST, files: [] } });
        let guidance = ((await handleGetUploadLink({ uploadLinkId: LINK_ID }, EXTRA)) as any).content[1].text;
        assert.match(guidance, /has expired.*create_upload_link/);
        assert.doesNotMatch(guidance, /have arrived through this link yet/);

        get = () => ({ data: { expiresAt: PAST, files: [FILE] } });
        guidance = ((await handleGetUploadLink({ uploadLinkId: LINK_ID }, EXTRA)) as any).content[1].text;
        assert.match(guidance, /mediaPaths/);
        assert.match(guidance, /has expired.*create_upload_link/);
    }],
    ['get: the API\'s nanosecond timestamps are read correctly on both sides of the expiry', async () => {
        reset();
        get = () => ({ data: { expiresAt: '2000-01-01T00:00:00.600141667Z', files: [] } });
        let guidance = ((await handleGetUploadLink({ uploadLinkId: LINK_ID }, EXTRA)) as any).content[1].text;
        assert.match(guidance, /has expired/);

        get = () => ({ data: { expiresAt: '2999-01-01T00:00:00.600141667Z', files: [] } });
        guidance = ((await handleGetUploadLink({ uploadLinkId: LINK_ID }, EXTRA)) as any).content[1].text;
        assert.match(guidance, /have arrived through this link yet/);
    }],
    ['get: 401, 404 and 429 each say what to do, others surface the API error', async () => {
        const expected: Array<[number, RegExp]> = [
            [401, /session has expired/],
            [404, /is unknown.*create_upload_link.*list_media/],
            [429, /too many requests/],
            [500, /status code 500.*backend text/],
        ];
        for (const [status, message] of expected) {
            reset();
            get = () => { throw httpError(status); };
            const result: any = await handleGetUploadLink({ uploadLinkId: LINK_ID }, EXTRA);
            assert.equal(result.isError, true);
            assert.match(text(result), message);
            const line = onlyLine('get_upload_link');
            assert.equal(line.outcome, 'failed');
            assert.equal(line.status, status);
        }
    }],
    ['schema: only an id passes, so a pasted link never reaches the request path or the log', async () => {
        const { inputSchema } = getUploadLinkTool;
        assert.deepEqual(inputSchema.parse({ uploadLinkId: LINK_ID }), { uploadLinkId: LINK_ID });
        for (const uploadLinkId of [LINK_URL, SECRET, '../../accounts', '', null, undefined]) {
            assert.equal(inputSchema.safeParse({ uploadLinkId }).success, false, String(uploadLinkId));
        }
    }],
    ['create takes no input', async () => {
        assert.deepEqual(Object.keys(createUploadLinkTool.inputSchema.shape), []);
    }],
    ['descriptions leave out the numbers the backend owns', async () => {
        const inputDescription = getUploadLinkTool.inputSchema.shape.uploadLinkId.description ?? '';
        for (const description of [createUploadLinkTool.description, getUploadLinkTool.description, inputDescription]) {
            assert.doesNotMatch(description, /\d/);
        }
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
