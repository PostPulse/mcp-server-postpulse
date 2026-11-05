import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import { handleUploadMedia } from '../src/tools/upload_media';

// Polls wait 2 s between status reads; run them immediately.
(globalThis as any).setTimeout = (fn: () => void) => { fn(); return 0; };

let states: any[] = [];
let reads = 0;

(clientModule as any).createApiClient = () => ({
    post: async () => ({ data: { id: 7 } }),
    get: async () => ({ data: states[Math.min(reads++, states.length - 1)] }),
});

function reset(next: any[]) {
    states = next;
    reads = 0;
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
