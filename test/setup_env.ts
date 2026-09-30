// Import this first in unit tests. src/config.ts validates the environment on import and requires
// REDIS_URL, but unit tests mock the API client and never connect to Redis. With this default,
// `npm test` runs on a clean checkout without a .env file.
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
