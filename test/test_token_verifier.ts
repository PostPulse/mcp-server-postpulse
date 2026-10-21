import './setup_env';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { configSchema } from '../src/config';
import { createTokenVerifier } from '../src/auth/token_verifier';
import { logger } from '../src/logger';

// ─── Local tenants: RSA keys generated at runtime, each JWKS on its own local HTTP server ────

const ISSUER = 'https://auth.post-pulse.com/';
const EU_CANONICAL = 'https://post-pulse.eu.auth0.com/';
const CANARY = 'https://auth-canary.post-pulse.com/';
const US_ONLY = 'https://us-only.example/'; // an issuer no EU configuration trusts
const API = 'https://api.post-pulse.com';
const MANAGEMENT_API = 'https://post-pulse.eu.auth0.com/api/v2/';

interface Tenant {
    kid: string;
    privateKey: CryptoKey;
    url: string;
    hits: number;
    // How the JWKS server fails: 'hang' accepts requests but never answers (jose times out), 'reset' drops the
    // connection (fetch fails), 503 answers with that status, 'malformed' answers 200 with no key set.
    // Unset: it serves the key set.
    fault?: 'hang' | 'reset' | 503 | 'malformed';
    server: http.Server;
}

async function tenant(kid: string): Promise<Tenant> {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
    const t = { kid, privateKey, url: '', hits: 0 } as Tenant;
    t.server = http.createServer((req, res) => {
        t.hits++;
        if (t.fault === 'hang') return;
        if (t.fault === 'reset') {
            req.socket.destroy();
            return;
        }
        if (t.fault === 503) {
            res.writeHead(503);
            res.end();
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(t.fault === 'malformed' ? {} : { keys: [jwk] }));
    });
    await new Promise<void>((resolve) => t.server.listen(0, '127.0.0.1', resolve));
    t.url = `http://127.0.0.1:${(t.server.address() as AddressInfo).port}/.well-known/jwks.json`;
    return t;
}

function sign(privateKey: CryptoKey, kid: string, claims: { iss?: string; aud?: string; exp?: string } = {}) {
    return new SignJWT({ azp: 'client-123', scope: 'openid postpulse-api/api' })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid })
        .setIssuer(claims.iss ?? ISSUER)
        .setAudience(claims.aud ?? API)
        .setSubject('email|user-1')
        .setIssuedAt()
        .setExpirationTime(claims.exp ?? '5m')
        .sign(privateKey);
}

const verifierFor = (env: Record<string, string>) =>
    createTokenVerifier(configSchema.parse({ REDIS_URL: 'redis://localhost:6379', ...env }));

const rejected = (message: RegExp) => (error: any) => {
    assert.ok(error instanceof InvalidTokenError, `expected InvalidTokenError, got ${error}`);
    assert.match(error.message, message);
    return true;
};

let us: Tenant;
let eu: Tenant;
let junkKey: CryptoKey; // a key no trusted set publishes
let logged: string[] = [];
(logger as any).error = (message: string) => { logged.push(message); };

const usOnly = () => ({ POSTPULSE_AUTH_US_JWKS_URI: us.url });
const euOn = () => ({
    ...usOnly(),
    POSTPULSE_AUTH_EU_JWKS_URI: eu.url,
    POSTPULSE_AUTH_EU_ISSUERS: `${ISSUER},${EU_CANONICAL},${CANARY}`,
});

// ─── Tests ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
    ['config defaults: US canonical JWKS bound to POSTPULSE_AUTH_ISSUER, EU off', async () => {
        const cfg = configSchema.parse({ REDIS_URL: 'redis://localhost:6379' });
        assert.equal(cfg.POSTPULSE_AUTH_ISSUER, ISSUER);
        assert.equal(cfg.POSTPULSE_AUDIENCE, API);
        assert.equal(cfg.POSTPULSE_AUTH_US_JWKS_URI, 'https://dev-yb150m5gz2ss41sl.us.auth0.com/.well-known/jwks.json');
        assert.deepEqual(cfg.POSTPULSE_AUTH_US_ISSUERS, [ISSUER]);
        assert.equal(cfg.POSTPULSE_AUTH_EU_JWKS_URI, '');
        assert.deepEqual(cfg.POSTPULSE_AUTH_EU_ISSUERS, []);
    }],
    ['config: US issuers follow POSTPULSE_AUTH_ISSUER; issuer lists are comma-separated and trimmed', async () => {
        const cfg = configSchema.parse({
            REDIS_URL: 'redis://localhost:6379',
            POSTPULSE_AUTH_ISSUER: CANARY,
            POSTPULSE_AUTH_EU_ISSUERS: ` ${ISSUER} , ${EU_CANONICAL},`,
        });
        assert.deepEqual(cfg.POSTPULSE_AUTH_US_ISSUERS, [CANARY]);
        assert.deepEqual(cfg.POSTPULSE_AUTH_EU_ISSUERS, [ISSUER, EU_CANONICAL]);
    }],
    ['EU off: US key + custom-domain issuer + API audience is accepted (clientId = azp)', async () => {
        const verifier = verifierFor(usOnly());
        const info = await verifier.verifyAccessToken(await sign(us.privateKey, us.kid));
        assert.equal(info.clientId, 'client-123');
        assert.deepEqual(info.scopes, ['openid', 'postpulse-api/api']);
        assert.equal(typeof info.expiresAt, 'number');
        assert.equal(eu.hits, 0);
    }],
    ['EU off: an EU-key token is rejected and the EU JWKS is never fetched, even with half of the EU set configured', async () => {
        const euHalves: Array<Record<string, string>> = [
            {},
            { POSTPULSE_AUTH_EU_JWKS_URI: eu.url },
            { POSTPULSE_AUTH_EU_JWKS_URI: eu.url, POSTPULSE_AUTH_EU_ISSUERS: ' , ' },
            { POSTPULSE_AUTH_EU_ISSUERS: EU_CANONICAL },
        ];
        for (const euHalf of euHalves) {
            const verifier = verifierFor({ ...usOnly(), ...euHalf });
            await assert.rejects(
                verifier.verifyAccessToken(await sign(eu.privateKey, eu.kid, { iss: EU_CANONICAL })),
                rejected(/no applicable key/),
            );
        }
        assert.equal(eu.hits, 0);
    }],
    ['EU off: US key + EU canonical issuer is rejected with the same log line as before', async () => {
        const verifier = verifierFor(usOnly());
        await assert.rejects(
            verifier.verifyAccessToken(await sign(us.privateKey, us.kid, { iss: EU_CANONICAL })),
            rejected(/^unexpected "iss" claim value$/),
        );
        assert.deepEqual(logged, ['[auth] JWT verification failed: unexpected "iss" claim value']);
    }],
    ['EU off: wrong audience and expired tokens are rejected', async () => {
        const verifier = verifierFor(usOnly());
        await assert.rejects(
            verifier.verifyAccessToken(await sign(us.privateKey, us.kid, { aud: MANAGEMENT_API })),
            rejected(/unexpected "aud" claim value/),
        );
        await assert.rejects(
            verifier.verifyAccessToken(await sign(us.privateKey, us.kid, { exp: '1 minute ago' })),
            rejected(/"exp" claim timestamp check failed/),
        );
    }],
    ['EU on: EU key is accepted with the custom-domain, EU canonical and canary issuers', async () => {
        const verifier = verifierFor(euOn());
        for (const iss of [ISSUER, EU_CANONICAL, CANARY]) {
            const info = await verifier.verifyAccessToken(await sign(eu.privateKey, eu.kid, { iss }));
            assert.equal(info.clientId, 'client-123');
        }
        await verifier.verifyAccessToken(await sign(us.privateKey, us.kid));
    }],
    ['EU on: EU key with the Management API audience is rejected', async () => {
        const verifier = verifierFor(euOn());
        await assert.rejects(
            verifier.verifyAccessToken(await sign(eu.privateKey, eu.kid, { aud: MANAGEMENT_API })),
            rejected(/unexpected "aud" claim value/),
        );
    }],
    ['EU on: US key + EU canonical issuer is rejected (issuers are bound to their key set)', async () => {
        const verifier = verifierFor(euOn());
        await assert.rejects(
            verifier.verifyAccessToken(await sign(us.privateKey, us.kid, { iss: EU_CANONICAL })),
            rejected(/^unexpected "iss" claim value$/),
        );
    }],
    ['EU on: EU key + an issuer only the US set trusts is rejected, before and after the EU kid is learned', async () => {
        const verifier = verifierFor({ ...euOn(), POSTPULSE_AUTH_US_ISSUERS: US_ONLY });
        const euKeyUsIssuer = () => sign(eu.privateKey, eu.kid, { iss: US_ONLY });
        await assert.rejects(verifier.verifyAccessToken(await euKeyUsIssuer()), rejected(/^unexpected "iss" claim value$/));
        await verifier.verifyAccessToken(await sign(eu.privateKey, eu.kid));
        await assert.rejects(verifier.verifyAccessToken(await euKeyUsIssuer()), rejected(/^unexpected "iss" claim value$/));
    }],
    ['an issuer failure tries the next set: a key in both sets passes with either set\'s issuers, in either order', async () => {
        for (const order of [[EU_CANONICAL, ISSUER], [ISSUER, EU_CANONICAL]]) {
            const verifier = verifierFor({ ...euOn(), POSTPULSE_AUTH_EU_JWKS_URI: us.url, POSTPULSE_AUTH_EU_ISSUERS: EU_CANONICAL });
            for (const iss of order) {
                await verifier.verifyAccessToken(await sign(us.privateKey, us.kid, { iss }));
            }
            await assert.rejects(
                verifier.verifyAccessToken(await sign(us.privateKey, us.kid, { iss: CANARY })),
                rejected(/^unexpected "iss" claim value$/),
            );
        }
    }],
    ['EU on: unknown kid is rejected', async () => {
        const verifier = verifierFor(euOn());
        await assert.rejects(verifier.verifyAccessToken(await sign(junkKey, 'junk-kid-1')), rejected(/no applicable key/));
    }],
    ['EU on: 100 random-kid tokens cost at most 2 JWKS fetches per set; valid tokens still pass', async () => {
        const verifier = verifierFor(euOn());
        for (let i = 0; i < 100; i++) {
            await assert.rejects(verifier.verifyAccessToken(await sign(junkKey, randomUUID())), InvalidTokenError);
        }
        assert.ok(us.hits <= 2, `US JWKS fetched ${us.hits} times`);
        assert.ok(eu.hits <= 2, `EU JWKS fetched ${eu.hits} times`);
        await verifier.verifyAccessToken(await sign(us.privateKey, us.kid));
        await verifier.verifyAccessToken(await sign(eu.privateKey, eu.kid, { iss: EU_CANONICAL }));
    }],
    ['EU on: a US JWKS timeout falls through to EU; kid affinity then skips the US set', async () => {
        us.fault = 'hang';
        const verifier = verifierFor(euOn());
        await verifier.verifyAccessToken(await sign(eu.privateKey, eu.kid));
        assert.equal(us.hits, 1);
        await verifier.verifyAccessToken(await sign(eu.privateKey, eu.kid));
        assert.equal(us.hits, 1);
        assert.equal(eu.hits, 1);
    }],
    ['EU on: with the US JWKS timing out, an EU-key token with an untrusted issuer reports the issuer failure', async () => {
        us.fault = 'hang';
        const verifier = verifierFor(euOn());
        await assert.rejects(
            verifier.verifyAccessToken(await sign(eu.privateKey, eu.kid, { iss: 'https://evil.example/' })),
            rejected(/^unexpected "iss" claim value$/),
        );
    }],
    ['EU on: a US JWKS that answers 503, drops the connection or serves no key set falls through to EU', async () => {
        const faults: Array<[Tenant['fault'], RegExp]> = [
            [503, /Expected 200 OK/],
            ['reset', /fetch failed/],
            ['malformed', /JSON Web Key Set malformed/],
        ];
        for (const [fault, usFailure] of faults) {
            us.fault = fault;
            us.hits = 0;
            eu.hits = 0;
            const verifier = verifierFor(euOn());
            await verifier.verifyAccessToken(await sign(eu.privateKey, eu.kid));
            assert.equal(us.hits, 1);
            assert.equal(eu.hits, 1);
            // A US token still fails, and reports the US failure rather than the EU set's "no matching key".
            await assert.rejects(verifier.verifyAccessToken(await sign(us.privateKey, us.kid)), rejected(usFailure));
        }
    }],
    ['a non-JWT bearer is rejected without any JWKS fetch', async () => {
        const verifier = verifierFor(euOn());
        await assert.rejects(verifier.verifyAccessToken('not-a-jwt'), rejected(/Invalid Compact JWS/));
        assert.equal(us.hits + eu.hits, 0);
    }],
    ['US off (T+14d): EU tokens pass, US tokens are rejected, the US JWKS is never fetched', async () => {
        const verifier = verifierFor({ ...euOn(), POSTPULSE_AUTH_US_JWKS_URI: '' });
        await verifier.verifyAccessToken(await sign(eu.privateKey, eu.kid));
        await assert.rejects(verifier.verifyAccessToken(await sign(us.privateKey, us.kid)), InvalidTokenError);
        assert.equal(us.hits, 0);
    }],
    ['no key set configured: the verifier refuses to start', async () => {
        assert.throws(() => verifierFor({ POSTPULSE_AUTH_US_JWKS_URI: '' }), /No trusted Auth0 key set/);
    }],
];

async function run() {
    us = await tenant('us-kid-1');
    eu = await tenant('eu-kid-1');
    junkKey = (await generateKeyPair('RS256')).privateKey;
    let failed = 0;
    for (const [name, fn] of tests) {
        for (const t of [us, eu]) {
            t.hits = 0;
            t.fault = undefined;
        }
        logged = [];
        try {
            await fn();
            console.log(`✅ ${name}`);
        } catch (error: any) {
            failed++;
            console.error(`❌ ${name}\n   ${error.message}`);
        }
    }
    for (const t of [us, eu]) {
        t.server.closeAllConnections();
        t.server.close();
    }
    console.log(`\n${tests.length - failed}/${tests.length} passed`);
    process.exit(failed ? 1 : 0);
}

run();
