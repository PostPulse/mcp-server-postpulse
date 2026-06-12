import { z } from 'zod';
import { jsonResult, toolContext, URLS } from './shared';
import { TELEGRAM_CONNECT_HINT } from './connect_account';

export const getStartedTool = {
    name: 'get_started',
    description: 'Check the user\'s PostPulse onboarding status: whether their PostPulse account is active, which social media accounts are connected, and exactly what to do next. Call this first in a new conversation, or whenever another tool reports a missing account or authorization problem. Returns the signed-in user, the connected accounts, readyToPost, and a concrete nextStep.',
    inputSchema: z.object({}),
};

export async function handleGetStarted(_args: any, extra: any) {
    const ctx = toolContext('get_started', extra);
    try {
        const [userRes, accountsRes] = await Promise.all([
            ctx.client.get('/v1/users'),
            ctx.client.get('/v1/accounts'),
        ]);

        const accounts = accountsRes.data.map((acc: any) => ({
            id: acc.id,
            platform: acc.platform,
            username: acc.accountUsername,
            name: acc.accountName,
            needsReauthorization: acc.needsReauthorization === true,
        }));
        const needingReauth = accounts.filter((a: any) => a.needsReauthorization);

        let nextStep: string;
        if (accounts.length === 0) {
            nextStep = 'Connect the user\'s first social media account: ask which platform they use (Instagram, Facebook, YouTube, TikTok, Threads, LinkedIn, X/Twitter, Bluesky), then call connect_account with that platform and have them open the returned URL. '
                + TELEGRAM_CONNECT_HINT;
        } else if (needingReauth.length > 0) {
            nextStep = `Ready to post on ${accounts.length - needingReauth.length} account(s), but ${needingReauth.length} account(s) need reauthorization (${needingReauth.map((a: any) => `${a.platform} id=${a.id}`).join(', ')}). To fix one, call connect_account with its platform and accountId and have the user open the returned URL.`;
        } else {
            nextStep = 'Everything is set up. Typical flow: list_accounts for IDs, upload_media if the post has an image/video, then schedule_post with a future ISO-8601 scheduledTime.';
        }

        ctx.ok({ accounts: accounts.length, zeroAccounts: accounts.length === 0, needsReauth: needingReauth.length });
        return jsonResult({
            signedInAs: { email: userRes.data.email, name: userRes.data.name },
            postpulseAccount: 'ACTIVE',
            connectedSocialAccounts: accounts,
            readyToPost: accounts.some((a: any) => !a.needsReauthorization),
            nextStep,
            manageAccountsUrl: URLS.accountsPage,
        });
    } catch (error: any) {
        return ctx.fail(error);
    }
}
