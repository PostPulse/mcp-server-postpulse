import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { config, type Config } from '../config';
import { logger } from '../logger';

interface KeySet {
    jwks: ReturnType<typeof createRemoteJWKSet>;
    issuers: string[];
}

// Bound on the kid -> key set map; each Auth0 tenant publishes 2-4 kids.
const MAX_AFFINITY = 16;

/**
 * Whether another key set may still verify the token: the kid is not in this set, the issuer is bound to
 * another set, or this set's JWKS did not answer in time.
 */
function tryNextSet(error: any): boolean {
    return error?.code === 'ERR_JWKS_NO_MATCHING_KEY'
        || error?.code === 'ERR_JWKS_TIMEOUT'
        || (error?.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' && error.claim === 'iss');
}

function kidOf(token: string): string | undefined {
    try {
        return decodeProtectedHeader(token).kid;
    } catch {
        return undefined; // jwtVerify rejects the malformed token with its usual message
    }
}

/**
 * Token verifier compatible with MCP SDK's requireBearerAuth middleware.
 * Verifies Auth0 JWTs against one JWKS per trusted Auth0 tenant (key set), each bound to its own issuers.
 */
export function createTokenVerifier(cfg: Config) {
    const sets: KeySet[] = [
        { jwksUri: cfg.POSTPULSE_AUTH_US_JWKS_URI, issuers: cfg.POSTPULSE_AUTH_US_ISSUERS },
        { jwksUri: cfg.POSTPULSE_AUTH_EU_JWKS_URI, issuers: cfg.POSTPULSE_AUTH_EU_ISSUERS },
    ]
        .filter((set) => set.jwksUri && set.issuers.length)
        // On an unknown kid, jose refetches a JWKS at most once per 30 s (its default cooldown).
        .map((set) => ({
            jwks: createRemoteJWKSet(new URL(set.jwksUri), { timeoutDuration: 3000 }),
            issuers: set.issuers,
        }));
    if (!sets.length) {
        throw new Error('No trusted Auth0 key set: set POSTPULSE_AUTH_US_* or POSTPULSE_AUTH_EU_* (JWKS_URI and ISSUERS)');
    }
    const affinity = new Map<string, KeySet>(); // kid -> the set that verified it

    async function verify(token: string) {
        const kid = kidOf(token);
        const known = kid ? affinity.get(kid) : undefined;
        let failure: any;
        for (const set of known ? [known] : sets) {
            try {
                const { payload } = await jwtVerify(token, set.jwks, {
                    issuer: set.issuers,
                    audience: cfg.POSTPULSE_AUDIENCE,
                });
                if (kid && !known) {
                    if (affinity.size >= MAX_AFFINITY) affinity.clear();
                    affinity.set(kid, set);
                }
                return payload;
            } catch (error: any) {
                if (!tryNextSet(error)) throw error;
                // Report the set that holds the kid, not a set that does not know it.
                if (!failure || failure.code === 'ERR_JWKS_NO_MATCHING_KEY') failure = error;
            }
        }
        throw failure;
    }

    return {
        verifyAccessToken: async (token: string) => {
            try {
                const payload = await verify(token);

                return {
                    token,
                    clientId: (payload.azp as string) || (payload.sub as string) || 'unknown',
                    scopes: payload.scope
                        ? (payload.scope as string).split(' ')
                        : [],
                    expiresAt: payload.exp,
                };
            } catch (error: any) {
                logger.error(`[auth] JWT verification failed: ${error.message}`);
                throw new InvalidTokenError(error.message);
            }
        },
    };
}

export const tokenVerifier = createTokenVerifier(config);
