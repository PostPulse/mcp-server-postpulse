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
    ['WhatsApp: the number is the chatId, the template and its variables go in platformSettings', async () => {
        const { result, publication } = await schedule({
            platform: 'WHATSAPP',
            whatsappPhoneNumberId: '106540352242922',
            contactListId: 42,
            templateName: 'autumn_sale',
            templateLanguage: 'en',
            headerParameter: 'Autumn sale',
            bodyParameters: { 1: '20%', 2: 'Sunday' },
            buttonParameters: { 0: 'autumn-2026' },
            mediaPaths: [KEYS[0]],
        });
        assert.equal(result.isError, undefined);
        assert.deepEqual(publication.platformSettings, {
            type: 'WHATSAPP',
            contactListId: 42,
            templateName: 'autumn_sale',
            templateLanguage: 'en',
            headerParameter: 'Autumn sale',
            bodyParameters: { 1: '20%', 2: 'Sunday' },
            buttonParameters: { 0: 'autumn-2026' },
        });
        assert.deepEqual(publication.posts, [{ chatId: '106540352242922', attachmentPaths: [KEYS[0]] }]);
    }],
    ['WhatsApp: variables the template has none of are left out', async () => {
        const { publication } = await schedule({
            platform: 'WHATSAPP', whatsappPhoneNumberId: 'phone-1', contactListId: 42, templateName: 'hello_world', templateLanguage: 'en_US',
        });
        assert.deepEqual(publication.platformSettings, {
            type: 'WHATSAPP', contactListId: 42, templateName: 'hello_world', templateLanguage: 'en_US',
        });
        assert.deepEqual(publication.posts, [{ chatId: 'phone-1' }]);
    }],
    ['WhatsApp fields sent for another platform are ignored', async () => {
        const { publication } = await schedule({
            platform: 'TELEGRAM', telegramChannelId: 'chat-1', content: 'Hi', whatsappPhoneNumberId: 'phone-1', templateName: 'x',
            androidVideoCompat: 'REPACK',
        });
        assert.deepEqual(publication.platformSettings, { type: 'TELEGRAM' });
        assert.deepEqual(publication.posts, [{ content: 'Hi', chatId: 'chat-1' }]);
    }],
    ['WhatsApp: androidVideoCompat chosen by the user goes in platformSettings as given', async () => {
        for (const androidVideoCompat of ['REPACK', 'SEND_AS_IS']) {
            const { publication } = await schedule({
                platform: 'WHATSAPP', whatsappPhoneNumberId: 'phone-1', contactListId: 42, templateName: 'promo_video',
                templateLanguage: 'en', mediaPaths: [KEYS[1]], androidVideoCompat,
            });
            assert.deepEqual(publication.platformSettings, {
                type: 'WHATSAPP', contactListId: 42, templateName: 'promo_video', templateLanguage: 'en', androidVideoCompat,
            });
            assert.deepEqual(publication.posts, [{ chatId: 'phone-1', attachmentPaths: [KEYS[1]] }]);
        }
    }],
    ['WhatsApp: a header video without androidVideoCompat is sent without the field, so the API decides', async () => {
        const { publication } = await schedule({
            platform: 'WHATSAPP', whatsappPhoneNumberId: 'phone-1', contactListId: 42, templateName: 'promo_video',
            templateLanguage: 'en', mediaPaths: [KEYS[1]],
        });
        assert.equal('androidVideoCompat' in publication.platformSettings, false);
    }],
    ['WhatsApp: the API refusal asking for androidVideoCompat reaches the agent word for word', async () => {
        reset();
        const refusal = 'WhatsApp template \'promo_video\' (en): the header video has its index (the MP4 moov box) at the end of the file,'
            + ' so WhatsApp on Android may fail to play it. Set androidVideoCompat in the WhatsApp platform settings to REPACK'
            + ' to let PostPulse move the index to the front without re-encoding, or to SEND_AS_IS to send the video unchanged';
        failure = { status: 400, data: { error: refusal } };
        const result: any = await handleSchedulePost({
            accountId: ACCOUNT_ID, scheduledTime: AT, platform: 'WHATSAPP', whatsappPhoneNumberId: 'phone-1', contactListId: 42,
            templateName: 'promo_video', templateLanguage: 'en', mediaPaths: [KEYS[1]],
        }, {});
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /status code 400/);
        assert.ok(result.content[0].text.includes(JSON.stringify({ error: refusal })));
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
