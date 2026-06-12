import { AxiosInstance } from 'axios';
import { createApiClient } from '../api/client';
import { logFunnel, userHash } from '../logging/funnel';

export const URLS = {
    home: 'https://post-pulse.com',
    accountsPage: 'https://post-pulse.com/app/accounts',
    billingPage: 'https://post-pulse.com/app/billing',
};

/** Tool result with a pretty-printed JSON payload (agents parse this reliably). */
export function jsonResult(payload: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

type ErrorKind =
    | 'unauthorized'
    | 'payment_required'
    | 'forbidden'
    | 'not_found'
    | 'bad_request'
    | 'api_error'
    | 'network'
    | 'invalid_arguments'
    | 'internal';

function classify(error: any): { kind: ErrorKind; httpStatus?: number; details?: string } {
    const status: number | undefined = error?.response?.status;
    const details = error?.response?.data?.error
        ?? (error?.response?.data ? JSON.stringify(error.response.data) : error?.message);
    if (status) {
        const kind: ErrorKind =
            status === 401 ? 'unauthorized'
            : status === 402 ? 'payment_required'
            : status === 403 ? 'forbidden'
            : status === 404 ? 'not_found'
            : status >= 500 ? 'api_error'
            : 'bad_request';
        return { kind, httpStatus: status, details };
    }
    if (error?.request) return { kind: 'network', details: error?.message };
    return { kind: 'internal', details: error?.message };
}

const GUIDANCE: Record<ErrorKind, { error: string; howToFix: string; helpUrl?: string }> = {
    unauthorized: {
        error: 'PostPulse rejected the request as unauthorized.',
        howToFix: 'The user\'s PostPulse authorization has expired or been revoked. Ask the user to re-authenticate this MCP connection in their MCP client (it will prompt a PostPulse sign-in). Signing in is enough — a PostPulse account is created automatically on first sign-in, no separate signup step needed.',
        helpUrl: URLS.home,
    },
    payment_required: {
        error: 'This action is not available on the user\'s current PostPulse plan.',
        howToFix: 'Ask the user to review their PostPulse plan, then retry.',
        helpUrl: URLS.billingPage,
    },
    forbidden: {
        error: 'PostPulse denied this action for the user\'s current plan or permissions.',
        howToFix: 'Ask the user to review their PostPulse plan and connected-account limits, then retry.',
        helpUrl: URLS.billingPage,
    },
    not_found: {
        error: 'The requested PostPulse resource was not found.',
        howToFix: 'If you passed an accountId, call list_accounts to get valid account IDs. For Facebook/Telegram destinations, call list_chats to get valid chat/page IDs.',
    },
    bad_request: {
        error: 'PostPulse rejected the request as invalid.',
        howToFix: 'Adjust the arguments based on the details and retry.',
    },
    api_error: {
        error: 'PostPulse API had a temporary problem.',
        howToFix: 'Wait a moment and retry. If it keeps failing, tell the user to try again later.',
    },
    network: {
        error: 'Could not reach the PostPulse API.',
        howToFix: 'Wait a moment and retry.',
    },
    invalid_arguments: {
        error: 'Invalid tool arguments.',
        howToFix: 'Adjust the arguments based on the details and retry.',
    },
    internal: {
        error: 'The tool failed unexpectedly.',
        howToFix: 'Retry once; if it persists, report the details to the user.',
    },
};

/**
 * Per-call context: API client + funnel logging with consistent identity fields.
 * Every tool handler creates one and reports exactly one ok()/fail()/invalid() outcome.
 */
export function toolContext(tool: string, extra: any) {
    const authInfo = extra?.authInfo;
    const startedAt = Date.now();
    const identity = {
        userHash: userHash(authInfo?.extra?.sub),
        clientId: authInfo?.clientId || 'unknown',
        sessionId: extra?.sessionId,
    };

    const log = (outcome: 'ok' | 'error', fields: Record<string, unknown>) =>
        logFunnel({
            evt: 'mcp_tool_call',
            tool,
            outcome,
            ...fields,
            ...identity,
            durMs: Date.now() - startedAt,
        });

    return {
        client: createApiClient(authInfo?.token || '', authInfo?.clientId || '') as AxiosInstance,

        /** Log a successful call. Pass funnel-relevant fields (counts, platform, …). */
        ok(fields: Record<string, unknown> = {}) {
            log('ok', fields);
        },

        /** Log a failure and return the standard error payload for the agent. */
        fail(error: any, fields: Record<string, unknown> = {}) {
            const { kind, httpStatus, details } = classify(error);
            log('error', { errorKind: kind, httpStatus, ...fields });
            const guidance = GUIDANCE[kind];
            return {
                ...jsonResult({
                    error: guidance.error,
                    details,
                    howToFix: guidance.howToFix,
                    ...(guidance.helpUrl ? { helpUrl: guidance.helpUrl } : {}),
                }),
                isError: true as const,
            };
        },

        /** Log an argument-validation failure and return it to the agent. */
        invalid(details: string) {
            log('error', { errorKind: 'invalid_arguments' });
            const guidance = GUIDANCE.invalid_arguments;
            return {
                ...jsonResult({ error: guidance.error, details, howToFix: guidance.howToFix }),
                isError: true as const,
            };
        },
    };
}
