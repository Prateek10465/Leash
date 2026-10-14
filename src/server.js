import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { Store } from './store.js';
import { PayPal } from './paypal.js';
import { Guard } from './guard.js';
import { compilePolicy, normalizePolicy } from './policy.js';
import { runAgent } from './agent.js';
import { runAttackSuite } from './attacks.js';
import { llmAvailable } from './llm.js';
import { authStore } from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function getSessionUser(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ||
    req.headers.cookie?.match(/leash_session=([^;]+)/)?.[1];
  return authStore.verifySession(token);
}

export function createApp({ store = new Store(config.dataFile), paypal = new PayPal() } = {}) {
  const guard = new Guard({ store, paypal });
  const app = express();

  // Webhooks need the raw body for signature verification, so mount this before express.json().
  app.post('/webhooks/paypal', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    try {
      const raw = req.body.toString('utf8');
      if (!(await paypal.verifyWebhook(req.headers, raw))) return res.status(400).json({ error: 'bad signature' });
      const rec = guard.handleWebhook(JSON.parse(raw));
      res.json({ ok: true, matched: Boolean(rec) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/favicon.ico', (_req, res) => res.status(204).end());
  app.use(express.json({ limit: '100kb' }));

  // Dedicated Auth Gate for browser HTML requests
  app.get('/login', (_req, res) => res.sendFile(path.join(here, '../public/login.html')));
  app.get('/', (req, res, next) => {
    const isBrowser = req.headers.accept?.includes('text/html');
    const hasSession = Boolean(getSessionUser(req));
    const isGuest = req.query.guest === '1' || req.query.approved || req.query.approval;
    if (isBrowser && !hasSession && !isGuest) {
      return res.redirect('/login');
    }
    next();
  });

  app.use(express.static(path.join(here, '../public')));
  app.use('/vendor/ag-grid', express.static(path.join(here, '../node_modules/ag-grid-community')));
  app.use('/vendor/fonts', express.static(path.join(here, '../node_modules/@fontsource-variable')));

  // Local Multi-User Auth Endpoints
  app.get('/api/auth/profiles', (_req, res) => res.json(authStore.getProfiles()));

  app.post('/api/auth/login', (req, res) => {
    try {
      const { email, password, profileId } = req.body || {};
      const session = profileId
        ? authStore.loginAsDemo(profileId)
        : authStore.login({ email, password });
      res.setHeader('Set-Cookie', `leash_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
      res.json(session);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/auth/signup', (req, res) => {
    try {
      const { name, email, password, role } = req.body || {};
      const session = authStore.signup({ name, email, password, role });
      res.setHeader('Set-Cookie', `leash_session=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
      res.json(session);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ||
      req.headers.cookie?.match(/leash_session=([^;]+)/)?.[1];
    authStore.logout(token);
    res.setHeader('Set-Cookie', 'leash_session=; Path=/; HttpOnly; Max-Age=0');
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    const user = getSessionUser(req);
    res.json({ user: user || authStore.getProfiles()[0], authenticated: Boolean(user) });
  });

  const stats = () => {
    const d = store.decisions;
    const now = Date.now();
    return {
      spentMonth: store.spentMonth(now),
      spentToday: store.spentToday(now),
      blocked: d.filter((x) => x.verdict === 'blocked').length,
      blockedValue: d.filter((x) => x.verdict === 'blocked').reduce((s, x) => s + x.request.amount, 0),
      pending: d.filter((x) => x.status === 'pending_approval').length,
      unguardedPaid: d.filter((x) => x.verdict === 'unguarded' && x.status === 'paid').reduce((s, x) => s + x.request.amount, 0),
    };
  };

  app.get('/api/state', (_req, res) =>
    res.json({
      policy: store.policy,
      decisions: store.decisions,
      stats: stats(),
      mode: { paypal: paypal.mode, llm: llmAvailable() ? config.model : null, channel3: Boolean(config.channel3Key) },
    }),
  );

  app.post('/api/policy/compile', async (req, res) => res.json(await compilePolicy(req.body?.text)));
  app.put('/api/policy', (req, res) => res.json(store.setPolicy(normalizePolicy(req.body?.policy || {}, req.body?.policy?.text))));

  // Streams the agent run as NDJSON so the UI can render each step live.
  app.post('/api/agent/run', async (req, res) => {
    const task = String(req.body?.task || '').slice(0, 500);
    if (!task) return res.status(400).json({ error: 'task required' });
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache');
    const emit = (ev) => res.write(`${JSON.stringify(ev)}\n`);
    await runAgent({ task, guarded: req.body?.guarded !== false, style: req.body?.style === 'standard' ? 'standard' : 'redteam', guard, emit });
    res.end();
  });

  app.post('/api/attacks/run', async (_req, res) => res.json(await runAttackSuite(store.policy)));

  app.post('/api/decisions/:id/reject', (req, res) => {
    const d = guard.reject(req.params.id);
    d ? res.json(d) : res.status(404).json({ error: 'not found' });
  });
  app.post('/api/reset', (_req, res) => { store.reset(); res.json({ ok: true }); });

  // Human returns from PayPal checkout -> capture -> back to the dashboard.
  app.get('/paypal/return', async (req, res) => {
    const d = await guard.completeApproval(String(req.query.token || ''));
    res.redirect(`/?${d ? `approved=${d.id}` : 'approval=unknown'}`);
  });
  app.get('/paypal/cancel', (_req, res) => res.redirect('/?approval=cancelled'));

  // Mock-mode stand-in for PayPal's approval page (sandbox mode redirects to the real one).
  app.get('/mock/paypal/approve', (req, res) => {
    const token = String(req.query.token || '').replace(/[^A-Z0-9]/g, '');
    const o = paypal.mockOrders.get(token);
    res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>PayPal (mock)</title>
<body style="font:16px system-ui;background:#f5f7fa;display:grid;place-items:center;min-height:100vh;margin:0">
<form method=get action="/paypal/return" style="background:#fff;padding:32px;border-radius:16px;box-shadow:0 8px 30px #0002;max-width:380px;width:calc(100% - 32px)">
<p style="color:#003087;font-weight:800;font-size:22px;margin:0 0 4px">PayPal <span style="font-weight:400;font-size:13px;color:#888">sandbox mock</span></p>
<p style="color:#555">Pay <b>$${o?.amount ?? '?'} ${o?.currency ?? ''}</b> to the merchant for:<br><i>${String(o?.description ?? '').replace(/[<>&]/g, '')}</i></p>
<input type=hidden name=token value="${token}"><button style="width:100%;padding:14px;border:0;border-radius:99px;background:#ffc439;font-weight:700;font-size:16px;cursor:pointer">Pay Now</button>
<p style="margin:16px 0 0;text-align:center"><a href="/paypal/cancel" style="color:#555">Cancel</a></p></form>`);
  });

  return { app, store, guard, paypal };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { app, paypal } = createApp();
  app.listen(config.port, () => {
    console.log(`Leash running at ${config.baseUrl}`);
    console.log(`  PayPal: ${paypal.mode}${paypal.mode === 'mock' ? ' (set PAYPAL_CLIENT_ID/SECRET for sandbox)' : ''}`);
    console.log(`  LLM:    ${llmAvailable() ? config.model : 'off — heuristics + scripted agent (set ANTHROPIC_API_KEY)'}`);
  });
}
