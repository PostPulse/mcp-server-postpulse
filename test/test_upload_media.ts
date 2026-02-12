import { handleUploadMedia } from '../src/tools/upload_media';
import axios from 'axios';
import * as clientModule from '../src/api/client';

// Simple verification script using manual mocks
async function runManualTest() {
    console.log('Starting binary upload test (manual mocks)...');

    // Mock createApiClient
    const mockPost = async (url: string, body: any) => {
        console.log(`Mock Client POST: ${url}`);
        if (url === '/v1/media/upload/urls') {
            // Validate inputs
            const buffer = Buffer.from('test-image-content');
            if (body.filename !== 'test-image.png' ||
                body.contentType !== 'image/png' ||
                body.sizeBytes !== buffer.length) {
                throw new Error(`Invalid arguments to createApiClient.post: ${JSON.stringify(body)}`);
            }
            return {
                data: {
                    url: 'https://s3.example.com/upload-url',
                    key: 'uploaded/file/key.png',
                    headers: { 'x-amz-acl': 'public-read' }
                }
            };
        }
        throw new Error(`Unexpected POST to ${url}`);
    };

    // Patch createApiClient
    (clientModule as any).createApiClient = () => ({
        post: mockPost,
        get: async () => ({ data: {} })
    });

    // Mock axios.put
    const originalPut = axios.put;
    (axios as any).put = async (url: string, body: any, config: any) => {
        console.log(`Mock Axios PUT: ${url}`);
        if (url !== 'https://s3.example.com/upload-url') {
            throw new Error(`Unexpected PUT URL: ${url}`);
        }
        if (body.toString() !== 'test-image-content') {
            throw new Error('Unexpected body content');
        }
        if (config.headers['Content-Type'] !== 'image/png') {
            throw new Error(`Unexpected Content-Type: ${config.headers['Content-Type']}`);
        }
        return { status: 200 };
    };

    try {
        const mediaData = Buffer.from('test-image-content').toString('base64');
        const mediaType = 'image/png';
        const mediaName = 'test-image.png';

        const result = await handleUploadMedia({
            mediaData,
            mediaType,
            mediaName
        }, {});

        console.log('Result:', result);

        if (result.content?.[0].text === 'uploaded/file/key.png') {
            console.log('✅ Manual Verification Passed');
        } else {
            console.error('❌ Manual Verification Failed: Incorrect result');
            process.exit(1);
        }

    } catch (err) {
        console.error('❌ Manual Verification Failed with error:', err);
        process.exit(1);
    } finally {
        // Restore potentially modified things (though process will exit)
        (axios as any).put = originalPut;
    }
}

runManualTest().catch(console.error);
