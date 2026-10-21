import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { z } from 'zod';

const csv = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);

export const configSchema = z.object({
  // Server
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().optional().describe('The public URL of this MCP server (e.g. https://mcp.post-pulse.com)'),

  // PostPulse Auth (Auth0)
  POSTPULSE_AUTH_ISSUER: z.string().default('https://auth.post-pulse.com/'),
  // Trusted key sets, one per Auth0 tenant: the tenant's canonical JWKS and the comma-separated issuers its keys
  // may sign for. A set with an empty JWKS URI or no issuers is off.
  POSTPULSE_AUTH_US_JWKS_URI: z.string().default('https://dev-yb150m5gz2ss41sl.us.auth0.com/.well-known/jwks.json'),
  POSTPULSE_AUTH_US_ISSUERS: z.string().optional().describe('Defaults to POSTPULSE_AUTH_ISSUER'),
  POSTPULSE_AUTH_EU_JWKS_URI: z.string().default(''),
  POSTPULSE_AUTH_EU_ISSUERS: z.string().default(''),
  POSTPULSE_AUDIENCE: z.string().default('https://api.post-pulse.com'),

  // PostPulse API
  POSTPULSE_API_URL: z.string().default('https://api.post-pulse.com'),

  // Redis (for MCP session/event persistence)
  REDIS_URL: z.string().describe('Redis connection URL (e.g. redis://default:password@host:6379)'),
  REDIS_IP_FAMILY: z.coerce
    .number()
    .pipe(z.union([z.literal(4), z.literal(6), z.literal(0)]))
    .default(6)
    .describe('IP address family for the Redis connection: 4, 6, or 0 (try both). Defaults to 6 for backwards compatibility with IPv6-only Redis endpoints; set 4 for IPv4-only endpoints.'),

  // Sentry
  SENTRY_DSN: z.string().optional().describe('Sentry DSN for error monitoring'),

  // Grafana Loki log shipping
  LOKI_URL: z.string().optional().describe('Grafana Loki base URL (e.g. https://logs-prod-012.grafana.net)'),
  LOKI_USER: z.string().optional().describe('Grafana Cloud Loki user id'),
  LOKI_PASSWORD: z.string().optional().describe('Grafana Cloud Loki API token'),

}).transform((env) => ({
  ...env,
  POSTPULSE_AUTH_US_ISSUERS: csv(env.POSTPULSE_AUTH_US_ISSUERS ?? env.POSTPULSE_AUTH_ISSUER),
  POSTPULSE_AUTH_EU_ISSUERS: csv(env.POSTPULSE_AUTH_EU_ISSUERS),
}));

export type Config = z.infer<typeof configSchema>;

export const config = configSchema.parse(process.env);
