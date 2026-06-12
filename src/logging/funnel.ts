import { createHash } from 'node:crypto';

/**
 * Structured funnel logging — one JSON line per event on stdout, so every event
 * is a single grep-able line in `fly logs`.
 *
 * Events:
 *   mcp_session_started / mcp_session_closed — session lifecycle
 *   mcp_auth_failed                          — bearer token rejected (expired/invalid)
 *   mcp_tool_call                            — one per tool invocation, with outcome
 *
 * Funnel queries (fly logs / any shipper):
 *   '"evt":"mcp_tool_call"'                          — all tool calls
 *   '"zeroAccounts":true'                            — users hitting the no-connected-account wall
 *   '"tool":"connect_account","outcome":"ok"'        — connect links issued
 *   '"tool":"schedule_post","outcome":"ok"'          — funnel completion
 */
export function logFunnel(fields: Record<string, unknown>) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...fields }));
}

/** Stable, non-reversible per-user key for counting distinct users in logs (no raw PII). */
export function userHash(sub: unknown): string {
    if (typeof sub !== 'string' || !sub) return 'unknown';
    return createHash('sha256').update(sub).digest('hex').slice(0, 12);
}
