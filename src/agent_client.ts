import { createApiClient } from './api/client';
import { logger } from './logger';

/** dev-portal endpoint that gives the token's dynamically registered client (azp) to the signed-in user. */
export const CLAIM_CLIENT_PATH = '/v1/apps/claim';

/** A claim must never slow a session down: it is not awaited and gives up after this long. */
const CLAIM_TIMEOUT_MS = 2_000;

interface AuthLike {
    token?: string;
    clientId?: string;
}

/**
 * Links the user's AI client to their PostPulse account when a session starts, so the client shows up among
 * their apps and the onboarding wizard sees that the agent is connected. Fire and forget: a failure is logged
 * and never reaches the user.
 */
export function claimAgentClient(auth: AuthLike | undefined): void {
    if (!auth?.token) return;
    createApiClient(auth.token, auth.clientId || '')
        .post(CLAIM_CLIENT_PATH, undefined, { timeout: CLAIM_TIMEOUT_MS })
        .catch((error: any) => logger.warn(
            { status: error?.response?.status, err: error?.message },
            'Agent client claim failed',
        ));
}
