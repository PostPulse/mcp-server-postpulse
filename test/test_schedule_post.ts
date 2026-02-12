
import { handleSchedulePost } from '../src/tools/schedule_post';
import * as clientModule from '../src/api/client';

// Manual mocks setup
const mockPost = async (url: string, body: any) => {
    console.log(`Mock Client POST: ${url}`);
    if (url === '/v1/posts') {
        console.log('Payload:', JSON.stringify(body, null, 2));
        return {
            data: {
                id: 12345
            }
        };
    }
    throw new Error(`Unexpected POST to ${url}`);
};

(clientModule as any).createApiClient = () => ({
    post: mockPost
});

async function runTests() {
    console.log('--- Test 1: Instagram Feed Post ---');
    await handleSchedulePost({
        accountId: 1,
        platform: 'INSTAGRAM',
        content: 'Hello Instagram!',
        mediaPaths: ['path/to/image.jpg'],
        scheduledTime: '2023-10-27T10:00:00Z',
        publicationType: 'FEED'
    }, {});

    console.log('\n--- Test 2: TikTok Video ---');
    await handleSchedulePost({
        accountId: 2,
        platform: 'TIKTOK',
        content: 'Check out this video!',
        mediaPaths: ['path/to/video.mp4'],
        scheduledTime: '2023-10-28T10:00:00Z',
        title: 'My Awesome Video'
    }, {});

    console.log('\n--- Test 3: Facebook Page Post ---');
    await handleSchedulePost({
        accountId: 3,
        platform: 'FACEBOOK',
        content: 'Facebook update',
        scheduledTime: '2023-10-29T10:00:00Z',
        facebookPageId: 'page-123'
    }, {});

    console.log('\n--- Test 4: Threads Post with Tag ---');
    await handleSchedulePost({
        accountId: 4,
        platform: 'THREADS',
        content: 'Threads update',
        scheduledTime: '2023-10-30T10:00:00Z',
        topicTag: 'tech'
    }, {});
}

runTests().catch(console.error);
