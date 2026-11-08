import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import { CLAIM_CLIENT_PATH, claimAgentClient } from '../src/agent_client';

let posts: Array<{ token: string; clientId: string; path: string; body: any; timeout?: number }> = [];

(clientModule as any).createApiClient = (token: string, clientId: string) => ({
    post: async (path: string, body: any, options: any) => {
        posts.push({ token, clientId, path, body, timeout: options?.timeout });
        return { data: undefined };
    },
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

const tests: Array<[string, () => Promise<void>]> = [
    ['a session start claims the client with the user token and a 2 s timeout', async () => {
        posts = [];
        claimAgentClient({ token: 'user-token', clientId: 'dcr-client' });
        await flush();
        assert.deepEqual(posts, [{
            token: 'user-token', clientId: 'dcr-client', path: CLAIM_CLIENT_PATH, body: undefined, timeout: 2000,
        }]);
    }],
    ['without a token nothing is sent', async () => {
        posts = [];
        claimAgentClient(undefined);
        claimAgentClient({ clientId: 'dcr-client' });
        await flush();
        assert.deepEqual(posts, []);
    }],
    ['a failing claim never throws', async () => {
        (clientModule as any).createApiClient = () => ({ post: async () => { throw new Error('gateway down'); } });
        claimAgentClient({ token: 'user-token', clientId: 'dcr-client' });
        await flush();
    }],
];

(async () => {
    for (const [name, run] of tests) {
        await run();
        console.log(`ok - ${name}`);
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
