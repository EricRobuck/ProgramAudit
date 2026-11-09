import express, { type NextFunction, type Request, type Response } from 'express';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import helmet from 'helmet';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { db } from './db.js';
import { csrfProtection, loadUser } from './lib/auth.js';
import { HttpError } from './lib/errors.js';
import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { catalogRouter } from './routes/catalog.js';
import { reviewsRouter } from './routes/reviews.js';
import { tasksRouter } from './routes/tasks.js';
import { reportsRouter } from './routes/reports.js';

export function createApp() {
  const config = getConfig();
  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
    }),
  );

  // Health check: reports only liveness and database reachability.
  app.get('/api/health', async (_req, res) => {
    try {
      await db().raw('select 1');
      res.json({ status: 'ok', database: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'unavailable' });
    }
  });

  const PgStore = connectPgSimple(session);
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 4 });
  app.use(
    session({
      name: 'pa.sid',
      store: new PgStore({ pool, tableName: 'session', createTableIfMissing: false, pruneSessionInterval: config.NODE_ENV === 'test' ? false : 900 }),
      secret: config.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.COOKIE_SECURE,
        maxAge: 8 * 60 * 60 * 1000,
      },
    }),
  );
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', csrfProtection(config.APP_ORIGIN));
  app.use('/api', loadUser);
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/api/auth', authRouter);
  app.use('/api', usersRouter, catalogRouter, reviewsRouter, tasksRouter, reportsRouter);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found', 'Unknown API route')));

  // Serve the built web client in production.
  const staticDir =
    config.STATIC_DIR ??
    [path.resolve(import.meta.dirname, '..', '..', 'client', 'dist'), path.resolve(import.meta.dirname, '..', '..', '..', 'client', 'dist')].find((d) =>
      fs.existsSync(path.join(d, 'index.html')),
    ) ??
    '';
  if (config.NODE_ENV !== 'test' && staticDir && fs.existsSync(path.join(staticDir, 'index.html'))) {
    app.use(express.static(staticDir, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
  }

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { type?: string; status?: number; code?: string; message?: string };
    if (e?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'bad_request', message: 'Malformed JSON body' } });
    }
    if (e?.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'too_large', message: 'Request body is too large' } });
    }
    if (e?.code === '23505') {
      return res.status(409).json({ error: { code: 'duplicate', message: 'That name is already in use' } });
    }
    // Log without request bodies (which may contain narrative text or passwords).
    console.error(`[error] ${req.method} ${req.path}:`, e?.code ?? '', e?.message ?? err);
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong. Please try again.' } });
  });

  return app;
}
