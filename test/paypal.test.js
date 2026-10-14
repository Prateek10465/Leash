// Sandbox-mode request shapes, with fetch stubbed. Live sandbox calls need real credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPal } from '../src/paypal.js';
import { config } from '../src/config.js';

function stub(handler) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body = {} } = handler(String(url), init, calls) || {};
    return { ok: status < 400, status, json: async () => body };
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const cfg = { ...config, paypalMode: 'sandbox', baseUrl: 'http://localhost:3000', paypal: { ...config.paypal, clientId: 'id', secret: 'sec', webhookId: 'WH', apiBase: 'https://api-m.sandbox.paypal.com', merchantEmail: 'm@x.com' } };
const route = (url) => (url.endsWith('/oauth2/token') ? { body: { access_token: 'tok', expires_in: 3600 } } : null);

test('createOrder posts an Orders v2 CAPTURE order with return urls and idempotency key', async () => {
  const s = stub((url) => route(url) || { body: { id: 'ORD1', status: 'PAYER_ACTION_REQUIRED', links: [{ rel: 'payer-action', href: 'https://sandbox.paypal.com/checkoutnow?token=ORD1' }] } });
  try {
    const pp = new PayPal(cfg);
    const o = await pp.createOrder({ amount: 39.99, description: 'Keyboard', referenceId: 'dec_1', requestId: 'dec_1' });
    assert.equal(o.approveUrl, 'https://sandbox.paypal.com/checkoutnow?token=ORD1');
    const auth = s.calls[0];
    assert.equal(auth.init.headers.Authorization, `Basic ${Buffer.from('id:sec').toString('base64')}`);
    const call = s.calls[1];
    assert.equal(call.url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders');
    assert.equal(call.init.headers['PayPal-Request-Id'], 'dec_1');
    assert.equal(call.init.headers.Authorization, 'Bearer tok');
    const body = JSON.parse(call.init.body);
    assert.equal(body.intent, 'CAPTURE');
    assert.equal(body.purchase_units[0].amount.value, '39.99');
    assert.equal(body.payment_source.paypal.experience_context.return_url, 'http://localhost:3000/paypal/return');
  } finally { s.restore(); }
});

test('captureOrder and sendPayout hit the right endpoints', async () => {
  const s = stub((url) => route(url) || (url.includes('/capture')
    ? { body: { id: 'ORD1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP1', amount: { value: '39.99' } }] } }] } }
    : { body: { batch_header: { payout_batch_id: 'B1', batch_status: 'PENDING' } } }));
  try {
    const pp = new PayPal(cfg);
    const cap = await pp.captureOrder('ORD1');
    assert.deepEqual([cap.status, cap.captureId], ['COMPLETED', 'CAP1']);
    const out = await pp.sendPayout({ email: 'm@x.com', amount: 20, note: 'n', itemId: 'dec_2' });
    assert.equal(out.batchId, 'B1');
    const payoutCall = s.calls.find((c) => c.url.endsWith('/v1/payments/payouts'));
    const body = JSON.parse(payoutCall.init.body);
    assert.equal(body.items[0].receiver, 'm@x.com');
    assert.equal(body.items[0].amount.value, '20.00');
    assert.equal(body.items[0].sender_item_id, 'dec_2');
  } finally { s.restore(); }
});

test('API errors surface PayPal debug ids', async () => {
  const s = stub((url) => route(url) || { status: 422, body: { message: 'Unprocessable', debug_id: 'abc123' } });
  try {
    await assert.rejects(new PayPal(cfg).sendPayout({ email: 'a@b.c', amount: 1, itemId: 'x' }), (e) => e.debugId === 'abc123' && e.status === 422);
  } finally { s.restore(); }
});

test('webhook verification calls verify-webhook-signature', async () => {
  const s = stub((url) => route(url) || { body: { verification_status: 'SUCCESS' } });
  try {
    const ok = await new PayPal(cfg).verifyWebhook({ 'paypal-transmission-id': 't' }, JSON.stringify({ id: 'WH-1' }));
    assert.equal(ok, true);
    assert.ok(s.calls.some((c) => c.url.endsWith('/v1/notifications/verify-webhook-signature')));
  } finally { s.restore(); }
});
