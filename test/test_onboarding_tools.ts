import dotenv from 'dotenv';
import { handleGetStarted } from '../src/tools/get_started';
import { handleConnectAccount } from '../src/tools/connect_account';
import { handleListAccounts } from '../src/tools/list_accounts';

dotenv.config();

/**
 * Smoke test for the onboarding tools.
 * - With POSTPULSE_ACCESS_TOKEN set: runs get_started, list_accounts, and mints a
 *   connect URL (safe — the OAuth state expires unused in ~10 minutes).
 * - Without a token: verifies the structured error payload + funnel log emitted
 *   for the unauthorized path (what an agent with an expired token would see).
 */
async function run() {
    const token = process.env.POSTPULSE_ACCESS_TOKEN || 'invalid-token-funnel-smoke-test';
    const extra = {
        authInfo: { token, clientId: 'onboarding-smoke-test', extra: { sub: 'auth0|smoke-test' } },
        sessionId: 'smoke-test-session',
    };

    console.log('\n--- get_started ---');
    console.log(JSON.stringify(await handleGetStarted({}, extra), null, 2));

    console.log('\n--- list_accounts ---');
    console.log(JSON.stringify(await handleListAccounts({}, extra), null, 2));

    console.log('\n--- connect_account (INSTAGRAM) ---');
    console.log(JSON.stringify(await handleConnectAccount({ platform: 'INSTAGRAM' }, extra), null, 2));
}

run().catch(console.error);
