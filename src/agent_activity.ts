import { createApiClient } from './api/client';
import { logger } from './logger';

/** Path of PostPulse's agent activity endpoint; the client is taken from the token, never sent. */
export const AGENT_ACTIVITY_PATH = '/v1/agent-clients/activity';

/** A report must never slow a tool down: it is not awaited and gives up after this long. */
const REPORT_TIMEOUT_MS = 2_000;

/** The backend keeps at most 500 characters of an error. */
const MAX_MESSAGE_LENGTH = 500;

interface AuthLike {
    token?: string;
    clientId?: string;
}

type Activity =
    | { event: 'SESSION_STARTED'; clientName?: string; clientVersion?: string }
    | { event: 'TOOL_CALLED'; tool: string; outcome: 'ok' | 'error'; message?: string };

/**
 * Tells PostPulse what the user's AI client just did, so the onboarding wizard can show it live.
 * Fire and forget: a failure is logged and never reaches the user.
 */
export function reportAgentActivity(auth: AuthLike | undefined, activity: Activity): void {
    if (!auth?.token) return;
    createApiClient(auth.token, auth.clientId || '')
        .post(AGENT_ACTIVITY_PATH, activity, { timeout: REPORT_TIMEOUT_MS })
        .catch((error: any) => logger.warn(
            { event: activity.event, status: error?.response?.status, err: error?.message },
            'Agent activity report failed',
        ));
}

/** The text a tool returned with isError, as the user would read it, for the wizard's live panel. */
function errorText(result: any): string | undefined {
    const text = (result?.content ?? []).find((part: any) => part?.type === 'text')?.text;
    return typeof text === 'string' ? text.slice(0, MAX_MESSAGE_LENGTH) : undefined;
}

/**
 * Wraps a tool handler so every call is reported once it ends. The SDK passes `extra` (with authInfo) last,
 * whether or not the tool has arguments.
 */
export function withActivity<A extends unknown[], R>(tool: string, handler: (...args: A) => R | Promise<R>) {
    return async (...args: A): Promise<R> => {
        const auth = (args[args.length - 1] as { authInfo?: AuthLike } | undefined)?.authInfo;
        try {
            const result = await handler(...args);
            const isError = (result as any)?.isError === true;
            reportAgentActivity(auth, {
                event: 'TOOL_CALLED',
                tool,
                outcome: isError ? 'error' : 'ok',
                ...(isError ? { message: errorText(result) } : {}),
            });
            return result;
        } catch (error: any) {
            reportAgentActivity(auth, {
                event: 'TOOL_CALLED',
                tool,
                outcome: 'error',
                message: String(error?.message ?? error).slice(0, MAX_MESSAGE_LENGTH),
            });
            throw error;
        }
    };
}
