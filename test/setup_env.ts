// Import this first in unit tests: src/config.ts requires REDIS_URL, which tests never use.
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
