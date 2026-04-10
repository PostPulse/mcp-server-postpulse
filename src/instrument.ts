import * as Sentry from '@sentry/node';

Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 1.0,
    sendDefaultPii: true,
});
