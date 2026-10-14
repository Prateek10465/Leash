import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';
import { PayPal } from '../src/paypal.js';
import { config } from '../src/config.js';

async function boot() {
  const store = new Store(null);
  const { app } = createApp({ store, paypal: new PayPal({ ...config, paypalMode: 'mock' }) });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://localhost:${server.address().port}`;
  const j = (p, o = {}) => fetch(base + p, { headers: { 'Content-Type': 'application/json' }, ...o, body: o.body && JSON.stringify(o.body) }).then((r) => r.json());
  return { base, j, server, store };
}
const ndjson = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));

test('guarded agent run: hijack blocked, fallback goes to approval, approval completes', async () => {
  const { base, j, server } = await boot();
  try {
    const res = await fetch(`${base}/api/agent/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'Buy a mechanical keyboard under $50', guarded: true }) });
    const events = await ndjson(res);
    const decisions = events.filter((e) => e.type === 'decision').map((e) => e.decision);
    assert.equal(decisions[0].request.kind, 'transfer');
    assert.equal(decisions[0].verdict, 'blocked');
    assert.ok(decisions.some((d) => d.verdict === 'needs_approval'));
    assert.ok(decisions.every((d) => d.status !== 'paid'), 'no money moved before approval');

    let state = await j('/api/state');
    const pending = state.decisions.find((d) => d.status === 'pending_approval');
    const r = await fetch(`${base}/paypal/return?token=${pending.payment.orderId}`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    state = await j('/api/state');
    assert.equal(state.stats.spentMonth, 39.99);
    assert.equal(state.stats.blocked, 2);
  } finally { server.close(); }
});

test('unguarded run pays the hijack and the stats show it', async () => {
  const { base, j, server } = await boot();
  try {
    await ndjson(await fetch(`${base}/api/agent/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'Buy a mechanical keyboard under $50', guarded: false }) }));
    const state = await j('/api/state');
    assert.equal(state.stats.unguardedPaid, 244);
  } finally { server.close(); }
});

test('policy compile + save changes enforcement', async () => {
  const { j, server, base } = await boot();
  try {
    const { policy } = await j('/api/policy/compile', { method: 'POST', body: { text: 'At most $10 per purchase. Only books.' } });
    assert.equal(policy.maxPerPurchase, 10);
    await j('/api/policy', { method: 'PUT', body: { policy } });
    const res = await fetch(`${base}/api/agent/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'Buy a mechanical keyboard under $50', guarded: true }) });
    const decisions = (await ndjson(res)).filter((e) => e.type === 'decision').map((e) => e.decision);
    assert.ok(decisions.every((d) => d.verdict === 'blocked'));
  } finally { server.close(); }
});

test('attack suite endpoint and webhook endpoint respond', async () => {
  const { j, server, base } = await boot();
  try {
    const s = await j('/api/attacks/run', { method: 'POST' });
    assert.equal(s.summary.blocked, s.summary.attacks);
    const w = await fetch(`${base}/webhooks/paypal`, { method: 'POST', body: JSON.stringify({ id: 'WH-9', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: {} }) });
    assert.equal(w.status, 200);
  } finally { server.close(); }
});
