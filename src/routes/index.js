// src/routes/index.js
import { Router } from 'express';

import { readAppSession } from '../utils/appSession.js';

import adminRouter from './admin.js';
import appApiRouter from './appApi.js';
import appLaunchRouter from './appLaunch.js';
import appProxyRouter from './appProxy.js';
import authRouter from './auth.js';
import callbacksRouter from './callbacks.js';
import orderRouter from './order.js';
import payRouter from './pay.js';
import paymentSessionRouter from './paymentSession.js';

export default function mountRoutes(app) {
  const r = Router();

  // 1) If launched from Shoplazza admin, bounce to /app-start (keeps URL clean)
  r.get('/', (req, res, next) => {
    if (req.query.install_from === 'admin' && (req.query.shop || req.query.hmac)) {
      const qs = new URLSearchParams(req.query).toString();
      return res.redirect(302, `/app-start?${qs}`);
    }
    return next(); // fall through to public/index.html
  });

  // 2) Gate /app.html by session (NOT by HMAC on every load)
  r.get('/app.html', (req, res, next) => {
    const sess = readAppSession(req);
    if (sess?.shop) return next(); // ok, let static serve app.html
    const qs = new URLSearchParams(req.query).toString();
    return res.redirect(302, `/app-start?${qs}`);
  });

  // Simple health check endpoint
  r.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // 3) “Feature” routers (prefix paths)
  r.use('/admin', adminRouter);
  r.use('/app-api', appApiRouter); // your app UI’s API
  r.use('/app-proxy', appProxyRouter);
  r.use('/auth', authRouter);
  r.use('/callbacks', callbacksRouter);
  r.use('/order', orderRouter);
  r.use('/pay', payRouter);
  r.use('/payments', paymentSessionRouter);

  // 4) HMAC-verified app start (mints session)
  r.use('/app-start', appLaunchRouter);

  // Mount the consolidated router at root
  app.use(r);
}
