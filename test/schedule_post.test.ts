import './setup_env';
import assert from 'node:assert/strict';
import * as clientModule from '../src/api/client';
import { handleSchedulePost } from '../src/tools/schedule_post';

const ACCOUNT_ID = 7;
const KEYS = ['user/a.jpg', 'user/b.mp4', 'user/c.png'];
const AT = '2030-01-01T10:00:00Z';

let posted: any[] = [];
let failure: { status: number; data: any } | null = null;

(clientModule as any).createApiClient = () => ({
    get: async () => ({ data: [{ id: ACCOUNT_ID, platform: 'ANY' }] }),
    post: async (_url: string, body: any) => {
        posted.push(body);
        if (failure) {
            throw Object.assign(new Error(`Request failed with status code ${failure.status}`), { response: { data: failure.data } });
        }
        return { data: { id: 555 } };
    },
});

function reset() {
    posted = [];
    failure = null;
}

async function schedule(args: Record<string, unknown>) {
    reset();
    const result: any = await handleSchedulePost({ accountId: ACCOUNT_ID, scheduledTime: AT, ...args }, {});
    return { result, text: result.content[0].text as string, publication: posted[0]?.publications[0] };
}

const tests: Array<[string, () => Promise<void>]> = [
    ['Instagram STORY: one post per key, in the given order, in one request at one time', async () => {
        const { result, text, publication } = await schedule({ platform: 'INSTAGRAM', publicationType: 'STORY', mediaPaths: KEYS });
        assert.equal(result.isError, undefined);
        assert.equal(posted.length, 1);
        assert.equal(posted[0].scheduledTime, AT);
        assert.equal(posted[0].publications.length, 1);
        assert.deepEqual(publication.posts, KEYS.map((key) => ({ attachmentPaths: [key] })));
        assert.deepEqual(publication.platformSettings, { type: 'INSTAGRAM', publicationType: 'STORY' });
        assert.match(text, /ID: 555/);
        assert.match(text, /3 stories/);
    }],
    ['Facebook STORY: every story keeps the Page id, and the text', async () => {
        const { publication } = await schedule({
            platform: 'FACEBOOK', publicationType: 'STORY', mediaPaths: KEYS.slice(0, 2), facebookPageId: 'page-1', content: 'Hello',
        });
        assert.deepEqual(publication.posts, [
            { content: 'Hello', chatId: 'page-1', attachmentPaths: [KEYS[0]] },
            { content: 'Hello', chatId: 'page-1', attachmentPaths: [KEYS[1]] },
        ]);
    }],
    ['Facebook Page STORY: one post per key and no chatId', async () => {
        const { publication } = await schedule({ platform: 'FACEBOOK_PAGE', publicationType: 'STORY', mediaPaths: KEYS.slice(0, 2) });
        assert.deepEqual(publication.posts, [{ attachmentPaths: [KEYS[0]] }, { attachmentPaths: [KEYS[1]] }]);
        assert.deepEqual(publication.platformSettings, { type: 'FACEBOOK_PAGE', publicationType: 'STORY' });
    }],
    ['a single story: one post, and the result does not speak of a series', async () => {
        const { text, publication } = await schedule({ platform: 'INSTAGRAM', publicationType: 'STORY', mediaPaths: [KEYS[0]] });
        assert.deepEqual(publication.posts, [{ attachmentPaths: [KEYS[0]] }]);
        assert.equal(text, 'Post scheduled successfully (ID: 555)');
    }],
    ['a story with no media reaches the API, which owns that rule', async () => {
        for (const mediaPaths of [undefined, []]) {
            const { publication } = await schedule({ platform: 'INSTAGRAM', publicationType: 'STORY', mediaPaths });
            assert.deepEqual(publication.posts, [{}]);
        }
    }],
    ['a carousel stays one post', async () => {
        const { text, publication } = await schedule({ platform: 'INSTAGRAM', publicationType: 'FEED', mediaPaths: KEYS });
        assert.deepEqual(publication.posts, [{ attachmentPaths: KEYS }]);
        assert.equal(text, 'Post scheduled successfully (ID: 555)');
    }],
    ['no publicationType means FEED: several keys stay one post', async () => {
        const { publication } = await schedule({ platform: 'FACEBOOK_PAGE', mediaPaths: KEYS });
        assert.deepEqual(publication.posts, [{ attachmentPaths: KEYS }]);
    }],
    ['a Telegram album stays one post even if an agent sends STORY for it', async () => {
        const { publication } = await schedule({
            platform: 'TELEGRAM', publicationType: 'STORY', mediaPaths: KEYS, telegramChannelId: 'chat-1',
        });
        assert.deepEqual(publication.posts, [{ chatId: 'chat-1', attachmentPaths: KEYS }]);
    }],
    ['an API refusal of a story comes back as an error', async () => {
        reset();
        failure = { status: 400, data: { error: 'Instagram Story publication should have exactly one media per post' } };
        const result: any = await handleSchedulePost(
            { accountId: ACCOUNT_ID, scheduledTime: AT, platform: 'INSTAGRAM', publicationType: 'STORY', mediaPaths: KEYS },
            {},
        );
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /status code 400/);
    }],
];

(async () => {
    let failed = 0;
    for (const [name, run] of tests) {
        try {
            await run();
            console.log(`ok   ${name}`);
        } catch (err) {
            failed++;
            console.error(`FAIL ${name}`, err);
        }
    }
    console.log(`${tests.length - failed}/${tests.length} schedule_post tests passed`);
    process.exit(failed ? 1 : 0);
})();
