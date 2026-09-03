import os from 'node:os';
import pino from 'pino';
import type { TransportTargetOptions } from 'pino';
import { config } from './config';

/**
 * Application logger (pino). Always writes to stdout. 
 * When LOKI_URL, LOKI_USER, and LOKI_PASSWORD are all set, logs are additionally shipped to Grafana Loki via the pino-loki worker-thread transport. 
 * Soft-fail by design: silenceErrors ensures a Loki outage can never crash or block the server.
 */

const targets: TransportTargetOptions[] = [
    // Explicit stdout target: with a targets array, pino no longer writes to
    // stdout by default, so 'pino/file' with destination 1 (fd of stdout) keeps it.
    {
        target: 'pino/file',
        level: 'debug',
        options: { destination: 1 },
    },
];

if (config.LOKI_URL && config.LOKI_USER && config.LOKI_PASSWORD) {
    targets.push({
        target: 'pino-loki',
        // debug stays local-only; info and above ship to Loki.
        level: 'info',
        options: {
            host: config.LOKI_URL,
            basicAuth: {
                username: config.LOKI_USER,
                password: config.LOKI_PASSWORD,
            },
            // interval is in seconds (pino-loki README); flush every ~5s.
            batching: { interval: 5 },
            timeout: 5000,
            silenceErrors: true,
            labels: {
                app: 'mcp-server-postpulse',
                env: process.env.NODE_ENV || 'production',
                host: os.hostname(),
                source: 'appender',
            },
        },
    });
}

export const logger = pino(
    { level: 'debug' },
    pino.transport({ targets }),
);
