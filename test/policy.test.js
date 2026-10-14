import test from 'node:test';
import assert from 'node:assert/strict';
import { heuristicCompile, evaluatePolicy, normalizePolicy } from '../src/policy.js';
import { DEFAULT_POLICY } from '../src/store.js';

test('compiles the default plain-English policy', () => {
  const p = heuristicCompile(DEFAULT_POLICY.text);
  assert.equal(p.maxPerPurchase, 50);
  assert.equal(p.approvalAbove, 30);
  assert.equal(p.monthlyLimit, 200);
  assert.deepEqual(p.allowedCategories, ['electronics', 'books']);
  assert.equal(p.allowTransfers, false);
});

test('compiles other phrasings', () => {
  const p = heuristicCompile('Spend up to $15 per order, $60 per month, $20 a day. Only groceries. Check with me above $10.');
  assert.equal(p.maxPerPurchase, 15);
  assert.equal(p.monthlyLimit, 60);
  assert.equal(p.dailyLimit, 20);
  assert.equal(p.approvalAbove, 10);
  assert.deepEqual(p.allowedCategories, ['groceries']);
});

test('normalize clamps junk and an approval threshold above the cap', () => {
  const p = normalizePolicy({ maxPerPurchase: 20, approvalAbove: 90, monthlyLimit: -5, allowedCategories: ['Books', 'books', ''], allowTransfers: 'yes' });
  assert.equal(p.approvalAbove, 20);
  assert.equal(p.monthlyLimit, null);
  assert.deepEqual(p.allowedCategories, ['books']);
  assert.equal(p.allowTransfers, false); // only a real boolean true enables transfers
});

const policy = heuristicCompile(DEFAULT_POLICY.text);
const buy = (o = {}) => ({ kind: 'purchase', amount: 20, currency: 'USD', category: 'electronics', merchantId: 'm', ...o });

test('policy verdicts', () => {
  assert.equal(evaluatePolicy(policy, buy()).verdict, 'allow');
  assert.equal(evaluatePolicy(policy, buy({ amount: 40 })).verdict, 'approve');
  assert.equal(evaluatePolicy(policy, buy({ amount: 51 })).verdict, 'deny');
  assert.equal(evaluatePolicy(policy, buy({ category: 'gift-cards' })).verdict, 'deny');
  assert.equal(evaluatePolicy(policy, { kind: 'transfer', amount: 5, payeeEmail: 'x@y.com' }).verdict, 'deny');
  assert.equal(evaluatePolicy(policy, buy({ amount: NaN })).verdict, 'deny');
  assert.equal(evaluatePolicy(policy, buy({ amount: -3 })).verdict, 'deny');
});

test('monthly limit and velocity use context', () => {
  assert.equal(evaluatePolicy(policy, buy({ amount: 25 }), { spentMonth: 180 }).verdict, 'deny');
  assert.equal(evaluatePolicy(policy, buy(), { txLastHour: 6 }).verdict, 'deny');
});
