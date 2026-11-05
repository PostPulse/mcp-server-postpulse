import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { logger } from './logger';

/** The largest request body this server parses. A tool call is one JSON-RPC message, so this also caps base64 uploads. */
export const MAX_BODY_KB = 100;

/** Base64 adds a third to a file, and the JSON-RPC message around it takes a little more. */
export const MAX_BASE64_FILE_KB = 75;

export const MEDIA_GALLERY_URL = 'https://post-pulse.com/app/gallery';

/** The way out for a file too large for base64. Shared by the tool texts and the 413 answer. */
export const LARGE_FILE_GUIDANCE = 'A file with a public URL goes through mediaUrl of upload_media. Otherwise call create_upload_link, show the user the link and wait until they say they are done, then call get_upload_link and pass the file keys to schedule_post in mediaPaths.';

/**
 * Gate for POST requests: the token first and the body only after it, so a request without a valid token
 * never makes the server parse anything. Other methods carry no JSON-RPC message and pass through untouched.
 */
export function authThenParseBody(auth: RequestHandler): RequestHandler {
    const parseBody = express.json({ limit: MAX_BODY_KB * 1024 });
    return (req, res, next) => {
        if (req.method !== 'POST') {
            next();
            return;
        }
        auth(req, res, (err?: unknown) => {
            if (err) {
                next(err);
                return;
            }
            parseBody(req, res, next);
        });
    };
}

/**
 * Answers a body over the limit with a JSON-RPC error the agent can act on, instead of Express' HTML page.
 * Logged to Loki and not reported to Sentry: this is a client error, and Sentry's Express handler skips it anyway.
 */
export const bodyTooLargeHandler: ErrorRequestHandler = (err, req, res, next) => {
    if (err?.type !== 'entity.too.large') {
        next(err);
        return;
    }
    const auth = (req as express.Request & { auth?: AuthInfo }).auth;
    logger.warn(
        {
            // A chunked body declares no length: `received` then shows how far it got before the limit.
            length: err.length ?? err.received,
            limit: err.limit,
            clientId: auth?.clientId,
            sub: auth?.extra?.sub,
        },
        'MCP request body over the limit',
    );
    res.status(413).json({
        jsonrpc: '2.0',
        error: {
            code: -32000,
            message: `The request is over this server's ${MAX_BODY_KB} KB limit and was not processed. mediaData of upload_media fits only files up to about ${MAX_BASE64_FILE_KB} KB. ${LARGE_FILE_GUIDANCE}`,
        },
        id: null,
    });
};
