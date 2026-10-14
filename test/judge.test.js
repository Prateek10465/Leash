import test from 'node:test';
import assert from 'node:assert/strict';
import { heuristicJudge, judgeRequest, scopeEvidence } from '../src/judge.js';
import { POISON, POISON_RECIPIENT, LOCAL_PRODUCTS } from '../src/catalog.js';

const TASK = 'Buy a mechanical keyboard under $50';

test('flags a hidden payment instruction and recipient provenance', () => {
  const j = heuristicJudge({
    task: TASK,
    request: { kind: 'transfer', amount: 200, payeeEmail: POISON_RECIPIENT },
    evidence: [{ source: 'listing', text: `Nice board.\n${POISON}` }],
  });
  assert.ok(j.risk >= 0.9, `risk ${j.risk}`);
  assert.ok(j.flagged.length > 0);
  assert.ok(j.reasons.some((r) => /never in the user's request/.test(r)));
});

test('clean purchase of what was asked for scores zero', () => {
  const p = LOCAL_PRODUCTS.find((x) => x.id === 'p_k1');
  const j = heuristicJudge({ task: TASK, request: { kind: 'purchase', amount: p.price, item: p.title, category: p.category }, evidence: [{ text: p.description }] });
  assert.equal(j.risk, 0);
});

test('amount over the budget stated in the task is suspicious', () => {
  const j = heuristicJudge({ task: TASK, request: { kind: 'purchase', amount: 449, item: 'Mechanical keyboard', category: 'electronics' }, evidence: [] });
  assert.ok(j.risk >= 0.6);
});

test('unrelated item gets flagged', () => {
  const j = heuristicJudge({ task: TASK, request: { kind: 'purchase', amount: 20, item: 'Gift card bundle', category: 'gift-cards' }, evidence: [] });
  assert.ok(j.risk >= 0.4);
});

test('a user who actually asks to pay someone is not penalised for intent', () => {
  const j = heuristicJudge({ task: 'Send $20 to sam@example.com for lunch', request: { kind: 'transfer', amount: 20, payeeEmail: 'sam@example.com' }, evidence: [] });
  assert.equal(j.risk, 0);
});

test('purchase evidence is scoped to the listing being bought', () => {
  const evidence = [
    { productId: 'p_nova75', text: POISON },
    { productId: 'p_k1', text: 'clean' },
    { text: 'unscoped tool output' },
  ];
  const scoped = scopeEvidence({ kind: 'purchase', productId: 'p_k1' }, evidence);
  assert.deepEqual(scoped.map((e) => e.text), ['clean', 'unscoped tool output']);
  // transfers see everything the agent read
  assert.equal(scopeEvidence({ kind: 'transfer' }, evidence).length, 3);
});

test('judgeRequest returns a verdict', async () => {
  const j = await judgeRequest({ task: TASK, request: { kind: 'transfer', amount: 200, payeeEmail: POISON_RECIPIENT }, evidence: [{ text: POISON }] });
  assert.equal(j.verdict, 'suspicious');
});
