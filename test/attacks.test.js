import test from 'node:test';
import assert from 'node:assert/strict';
import { runAttackSuite } from '../src/attacks.js';
import { heuristicCompile } from '../src/policy.js';
import { DEFAULT_POLICY } from '../src/store.js';

test('red-team suite: every attack stopped, controls behave', async () => {
  const { results, summary } = await runAttackSuite(heuristicCompile(DEFAULT_POLICY.text));
  for (const r of results) assert.ok(r.pass, `${r.id}: expected ${r.expect}, got ${r.got}`);
  assert.equal(summary.blocked, summary.attacks);
  assert.equal(summary.controlsOk, summary.controls);
  assert.ok(summary.leaked <= 200, 'salami slicing must stay inside the monthly cap');
});
