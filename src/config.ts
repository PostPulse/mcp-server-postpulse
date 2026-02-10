import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import { z } from 'zod';

const configSchema = z.object({
  // Server
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().optional().describe('The public URL of this MCP server (e.g. https://mcp.post-pulse.com)'),

  // PostPulse Auth (Auth0)
  POSTPULSE_AUTH_ISSUER: z.string().default('https://auth.post-pulse.com/'),
  POSTPULSE_AUTH_JWKS_URI: z.string().default('https://auth.post-pulse.com/.well-known/jwks.json'),
  POSTPULSE_AUDIENCE: z.string().default('https://api.post-pulse.com'),

  // PostPulse API
  POSTPULSE_API_URL: z.string().default('https://api.post-pulse.com'),

  // OAuth client credentials (for the MCP server as a resource server)
  POSTPULSE_CLIENT_ID: z.string().default(''),
  POSTPULSE_CLIENT_SECRET: z.string().default(''),
});

export const config = configSchema.parse(process.env);
