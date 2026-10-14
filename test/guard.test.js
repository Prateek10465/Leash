import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { PayPal } from '../src/paypal.js';
import { Guard } from '../src/guard.js';
import { config } from '../src/config.js';
import { POISON, POISON_RECIPIENT } from '../src/catalog.js';

const TASK = 'Buy a mechanical keyboard under $50';
const make = () => {
  const store = new Store(null);
  const paypal = new PayPal({ ...config, paypalMode: 'mock' });
  return { store, paypal, guard: new Guard({ store, paypal }) };
};
const kb = (o = {}) => ({ kind: 'purchase', amount: 27.99, item: 'Mini Mechanical Keyboard', category: 'electronics', merchantId: 'keyhaus', merchantName: 'KeyHaus', ...o });

test('in-policy purchase is paid via payout and counted against the ledger', async () => {
  const { guard, store } = make();
  const d = await guard.authorize(kb(), { task: TASK, evidence: [] });
  assert.equal(d.verdict, 'allowed');
  assert.equal(d.status, 'paid');
  assert.equal(d.payment.type, 'payout');
  assert.equal(store.spentMonth(), 27.99);
});

test('hijack is blocked, no payment object, nothing counted', async () => {
  const { guard, store } = make();
  const d = await guard.authorize({ kind: 'transfer', amount: 200, payeeEmail: POISON_RECIPIENT }, { task: TASK, evidence: [{ source: 'listing', text: POISON }] });
  assert.equal(d.verdict, 'blocked');
  assert.equal(d.status, 'blocked');
  assert.equal(d.payment, undefined);
  assert.equal(d.blockedBy, 'policy+judge');
  assert.equal(store.spentMonth(), 0);
});

test('over the auto-approve limit: order opened, human approval captures it', async () => {
  const { guard, store } = make();
  const d = await guard.authorize(kb({ amount: 39.99, item: 'Typewriter K1 Mechanical Keyboard' }), { task: TASK, evidence: [] });
  assert.equal(d.verdict, 'needs_approval');
  assert.equal(d.status, 'pending_approval');
  assert.match(d.payment.approveUrl, /approve/);
  assert.equal(store.spentMonth(), 0, 'nothing spent before approval');
  const done = await guard.completeApproval(d.payment.orderId);
  assert.equal(done.status, 'paid');
  assert.equal(done.approvedBy, 'human');
  assert.equal(store.spentMonth(), 39.99);
  // approving twice must not capture twice
  const again = await guard.completeApproval(d.payment.orderId);
  assert.equal(again.status, 'paid');
});

test('rejecting a pending approval moves no money', async () => {
  const { guard, store } = make();
  const d = await guard.authorize(kb({ amount: 40 }), { task: TASK, evidence: [] });
  assert.equal(guard.reject(d.id).status, 'rejected');
  assert.equal(await guard.completeApproval(d.payment.orderId).then((x) => x.status), 'rejected');
  assert.equal(store.spentMonth(), 0);
});

test('monthly cap contains salami slicing', async () => {
  const { guard, store } = make();
  const out = [];
  for (let i = 0; i < 8; i++) out.push(await guard.authorize(kb({ amount: 29 }), { task: TASK, evidence: [] }));
  assert.ok(store.spentMonth() <= 200);
  assert.equal(out.at(-1).verdict, 'blocked');
});

test('unguarded path pays anything and is recorded as such', async () => {
  const { guard, store } = make();
  const d = await guard.executeUnguarded({ kind: 'transfer', amount: 200, payeeEmail: POISON_RECIPIENT });
  assert.equal(d.verdict, 'unguarded');
  assert.equal(d.status, 'paid');
  assert.equal(store.spentMonth(), 0, 'unguarded spend is not counted as policy-approved spend');
});

test('webhook events update the log idempotently', async () => {
  const { guard } = make();
  const d = await guard.authorize(kb({ amount: 20 }), { task: TASK, evidence: [] });
  const ev = { id: 'WH-1', event_type: 'PAYMENT.PAYOUTS-ITEM.FAILED', resource: { payout_item: { sender_item_id: d.id } } };
  const r1 = guard.handleWebhook(ev);
  assert.equal(r1.status, 'failed');
  guard.handleWebhook(ev);
  assert.equal(guard.store.getDecision(d.id).events.length, 1);
});

test('a PayPal failure is recorded, not thrown', async () => {
  const { guard, paypal } = make();
  paypal.sendPayout = async () => { throw Object.assign(new Error('INSUFFICIENT_FUNDS'), { name: 'PayPalError', debugId: 'dbg1' }); };
  const d = await guard.authorize(kb({ amount: 20 }), { task: TASK, evidence: [] });
  assert.equal(d.status, 'failed');
  assert.equal(d.debugId, 'dbg1');
});
