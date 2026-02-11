import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { handleListAccountsResource } from '../src/resources/accounts';
import { handleListChats } from '../src/tools/list_chats';
import { handleUploadMedia } from '../src/tools/upload_media';
import { handleSchedulePost } from '../src/tools/schedule_post';

dotenv.config();

function formatOutput(result: any) {
    if (result.isError) {
        console.error('❌ Error:', result.content[0].text);
    } else {
        console.log('✅ Success:', result.content[0].text);
    }
}

async function runVerification() {
    console.log('=== PostPulse MCP Server Verification ===');

    // Check for tokens in env OR in credentials file
    const hasEnvToken = process.env.POSTPULSE_ACCESS_TOKEN;
    const hasStoredToken = fs.existsSync(path.resolve(process.cwd(), '.credentials.json'));

    if (!hasEnvToken && !hasStoredToken) {
        console.error('❌ No access token found in .env OR .credentials.json');
        console.error('Please run `npm run login` to authenticate.');
        process.exit(1);
    }

    if (!process.env.POSTPULSE_CLIENT_ID) {
        console.error('❌ Missing POSTPULSE_CLIENT_ID in .env');
        process.exit(1);
    }

    console.log('\n--- 1. Testing accounts resource ---');
    const resourceResult = await handleListAccountsResource(new URL('postpulse://accounts'), {
        authInfo: { token: process.env.POSTPULSE_ACCESS_TOKEN || '' }
    });

    if (!resourceResult.contents || resourceResult.contents.length === 0) {
        console.error('❌ Resource returned no content');
        return;
    }

    console.log('✅ Success: Resource fetched');
    const accounts = JSON.parse(resourceResult.contents[0].text as string);
    if (accounts.length === 0) {
        console.log('⚠️ No accounts found. Cannot proceed with further tests.');
        return;
    }

    const firstAccount = accounts[0];
    console.log(`Using account: ${firstAccount.username} (${firstAccount.platform}) ID: ${firstAccount.id}`);

    console.log('\n--- 2. Testing list_chats ---');
    const chatsResult = await handleListChats({
        accountId: firstAccount.id,
        platform: firstAccount.platform
    }, {
        authInfo: { token: process.env.POSTPULSE_ACCESS_TOKEN || '' }
    });
    formatOutput(chatsResult);

    console.log('\n--- 3. Testing Upload Media (Dry Run with dummy URL) ---');
    // We won't actually wait for a real upload unless user provides a URL args, 
    // but we can try to call it and see if it fails auth or validation.
    // Uncomment to test with a real URL:
    // const mediaResult = await handleUploadMedia({ url: 'https://placehold.co/600x400.png' });
    // formatOutput(mediaResult);

    console.log('\n--- 4. Testing Schedule Post (Dry Run - creating payload only) ---');
    // Since we don't want to actually spam the account, we'll just log that the function exists 
    // and would be called with these args:
    console.log('Would call schedule_post with:', {
        accountId: firstAccount.id,
        platform: firstAccount.platform,
        content: "Hello from PostPulse MCP!",
        scheduledTime: new Date(Date.now() + 86400000).toISOString()
    });
}

runVerification().catch(console.error);
