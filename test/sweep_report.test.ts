import './setup_env';
import assert from 'node:assert/strict';
import { reportSweep, startSessionSweeper, type McpSessions } from '../src/mcp_handler';
import { SessionRegistry } from '../src/session_registry';
import { logger } from '../src/logger';

// What a sweep leaves in the log and in Sentry: a failed close must not pass silently, and an idle server must not
// write the same line every five minutes.

type Line = { level: string; message: string; fields?: Record<string, unknown> };
let lines: Line[] = [];
const record = (level: string) => (first: unknown, second?: string) => {
    lines.push(typeof first === 'string'
        ? { level, message: first }
        : { level, message: second ?? '', fields: first as Record<string, unknown> });
};
(logger as any).info = record('info');
(logger as any).warn = record('warn');
(logger as any).error = record('error');

// src/mcp_handler.ts reads captureException from the module on every call, so the module itself gets the stand-in.
let captured: Array<{ error: unknown; hint: unknown }> = [];
(require('@sentry/node') as any).captureException = (error: unknown, hint: unknown) => {
    captured.push({ error, hint });
    return '';
};

function reset() {
    lines = [];
    captured = [];
}

/** The message without the emoji some lines start with. */
const text = (line: Line) => line.message.replace(/^[^A-Za-z]+/, '');

async function waitFor(what: string, condition: () => boolean, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

const tests: Array<[string, () => Promise<void>]> = [
    ['a closed session and an ended stream get a line each, then the size of the map', async () => {
        reset();
        reportSweep(
            { expired: [{ sessionId: 'a', idleMs: 90 * 60 * 1000, openRequests: 0 }], failed: [], streamsClosed: ['b'] },
            { sessions: 3, busy: 1 },
        );
        assert.deepEqual(lines.map((line) => [line.level, text(line), line.fields]), [
            ['info', 'MCP Session expired: a', { idleMinutes: 90, openRequests: 0 }],
            ['info', 'MCP Session GET stream ended after the idle limit: b', undefined],
            ['info', 'MCP sessions in memory', { sessions: 3, busy: 1, expired: 1, streamsClosed: 1, failed: 0 }],
        ]);
        assert.deepEqual(captured, []);
    }],
    ['a failed close is a warning in the log and an event in Sentry', async () => {
        reset();
        const boom = new Error('boom');
        reportSweep(
            {
                expired: [{ sessionId: 'a', idleMs: 60 * 60 * 1000, openRequests: 0 }],
                failed: [{ sessionId: 'a', error: boom }, { sessionId: 'b', error: 'not an Error' }],
                streamsClosed: [],
            },
            { sessions: 1, busy: 1 },
        );
        assert.deepEqual(lines.filter((line) => line.level === 'warn').map((line) => [text(line), line.fields]), [
            ['MCP Session failed to close: a', { err: 'boom' }],
            ['MCP Session failed to close: b', { err: 'not an Error' }],
        ]);
        assert.deepEqual(captured, [
            { error: boom, hint: { extra: { sessionId: 'a' } } },
            { error: 'not an Error', hint: { extra: { sessionId: 'b' } } },
        ]);
        assert.deepEqual(lines.at(-1)!.fields, { sessions: 1, busy: 1, expired: 1, streamsClosed: 0, failed: 2 });
    }],
    ['an empty map with nothing done writes nothing', async () => {
        reset();
        reportSweep({ expired: [], failed: [], streamsClosed: [] }, { sessions: 0, busy: 0 });
        assert.deepEqual(lines, []);
        assert.deepEqual(captured, []);
    }],
    ['sessions in the map and nothing done: only the size of the map', async () => {
        reset();
        reportSweep({ expired: [], failed: [], streamsClosed: [] }, { sessions: 2, busy: 1 });
        assert.deepEqual(lines.map((line) => [line.level, text(line), line.fields]), [
            ['info', 'MCP sessions in memory', { sessions: 2, busy: 1, expired: 0, streamsClosed: 0, failed: 0 }],
        ]);
    }],
    ['the last session closed: the line is written once more, with an empty map', async () => {
        reset();
        reportSweep({ expired: [{ sessionId: 'a', idleMs: 60 * 60 * 1000, openRequests: 0 }], failed: [], streamsClosed: [] }, { sessions: 0, busy: 0 });
        assert.deepEqual(lines.at(-1)!.fields, { sessions: 0, busy: 0, expired: 1, streamsClosed: 0, failed: 0 });
    }],
    ['the sweeper reports each sweep; an error of the report goes to the log and Sentry, and the timer goes on', async () => {
        reset();
        const sessions: McpSessions = new SessionRegistry({ idleMs: 60 * 60 * 1000 });
        sessions.add('s1', { closeStandaloneSSEStream: () => {} } as any, { close: async () => {} });
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);

        const timer = startSessionSweeper(sessions, 5);
        assert.equal(timer.hasRef(), false);
        await waitFor('the first sweeps', () => lines.length >= 2);
        assert.ok(lines.every((line) => text(line) === 'MCP sessions in memory' && line.fields?.sessions === 1));

        // The report itself fails, as with a logger that throws.
        const boom = new Error('report boom');
        const info = (logger as any).info;
        (logger as any).info = () => { throw boom; };
        reset();
        // More than one: the timer goes on after a failed report.
        await waitFor('two failed reports', () => lines.length >= 2 && captured.length >= 2);
        (logger as any).info = info;
        assert.deepEqual(lines[0], { level: 'error', message: 'MCP session sweep failed', fields: { err: 'report boom' } });
        assert.equal(captured[0].error, boom);

        clearInterval(timer);
        await new Promise((resolve) => setImmediate(resolve));
        process.off('unhandledRejection', onUnhandled);
        assert.deepEqual(unhandled, []);
    }],
];

(async () => {
    for (const [name, run] of tests) {
        await run();
        console.log(`ok - ${name}`);
    }
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
