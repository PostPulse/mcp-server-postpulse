import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config';

const JWKS = createRemoteJWKSet(new URL(config.POSTPULSE_AUTH_JWKS_URI));

/**
 * Token verifier compatible with MCP SDK's requireBearerAuth middleware.
 * Verifies Auth0 JWTs using JWKS (no introspection endpoint needed).
 */
export const tokenVerifier = {
    verifyAccessToken: async (token: string) => {
        try {
            const { payload } = await jwtVerify(token, JWKS, {
                issuer: config.POSTPULSE_AUTH_ISSUER,
                audience: config.POSTPULSE_AUDIENCE,
            });

            return {
                token,
                clientId: (payload.azp as string) || (payload.sub as string) || 'unknown',
                scopes: payload.scope
                    ? (payload.scope as string).split(' ')
                    : [],
                expiresAt: payload.exp,
            };
        } catch (error: any) {
            console.error('[auth] JWT verification failed:', error.message);
            throw new Error(`Invalid or expired token: ${error.message}`);
        }
    },
};
