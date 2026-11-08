import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import { AGENT_ACTIVITY_PATH, reportAgentActivity, withActivity } from '../src/agent_activity';

let posts: Array<{ token: string; path: string; body: any; timeout?: number }> = [];

(clientModule as any).createApiClient = (token: string) => ({
    post: async (path: string, body: any, options: any) => {
        posts.push({ token, path, body, timeout: options?.timeout });
        return { data: undefined };
    },
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const extra = { authInfo: { token: 'user-token', clientId: 'dcr-client' } };

const tests: Array<[string, () => Promise<void>]> = [
    ['a successful tool call is reported as ok, with the user token and a 2 s timeout', async () => {
        posts = [];
        const handler = withActivity('list_accounts', async (_args: unknown, _extra: unknown) => ({ content: [] }));
        await handler({}, extra);
        await flush();
        assert.deepEqual(posts, [{
            token: 'user-token',
            path: AGENT_ACTIVITY_PATH,
            body: { event: 'TOOL_CALLED', tool: 'list_accounts', outcome: 'ok' },
            timeout: 2000,
        }]);
    }],
    ['an isError result is reported as error with its text', async () => {
        posts = [];
        const handler = withActivity('schedule_post', async (_args: unknown, _extra: unknown) => ({
            content: [{ type: 'text', text: 'Error: TikTok needs a video' }],
            isError: true,
        }));
        const result = await handler({}, extra);
        await flush();
        assert.equal(result.isError, true);
        assert.deepEqual(posts.map((p) => p.body), [{
            event: 'TOOL_CALLED', tool: 'schedule_post', outcome: 'error', message: 'Error: TikTok needs a video',
        }]);
    }],
    ['a thrown error is reported and still thrown', async () => {
        posts = [];
        const handler = withActivity('get_post', async (_args: unknown, _extra: unknown) => {
            throw new Error('boom');
        });
        await assert.rejects(handler({}, extra), /boom/);
        await flush();
        assert.equal(posts[0].body.outcome, 'error');
        assert.equal(posts[0].body.message, 'boom');
    }],
    ['without a token nothing is reported', async () => {
        posts = [];
        reportAgentActivity(undefined, { event: 'SESSION_STARTED', clientName: 'cursor' });
        await withActivity('list_media', async (_extra: unknown) => ({ content: [] }))({});
        await flush();
        assert.deepEqual(posts, []);
    }],
    ['a failing report never reaches the tool result', async () => {
        (clientModule as any).createApiClient = () => ({ post: async () => { throw new Error('gateway down'); } });
        const handler = withActivity('list_accounts', async (_args: unknown, _extra: unknown) => ({ content: [] }));
        const result = await handler({}, extra);
        await flush();
        assert.deepEqual(result, { content: [] });
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
