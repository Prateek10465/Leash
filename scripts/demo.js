// Terminal version of the demo: same attack, with and without Leash. `npm run demo`
import { Store } from '../src/store.js';
import { PayPal } from '../src/paypal.js';
import { Guard } from '../src/guard.js';
import { runAgent } from '../src/agent.js';
import { config } from '../src/config.js';

const TASK = process.argv[2] || 'Buy a mechanical keyboard under $50';
const c = { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, amber: (s) => `\x1b[33m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };

async function scenario(guarded) {
  const store = new Store(null);
  const guard = new Guard({ store, paypal: new PayPal() });
  console.log(`\n${c.b(guarded ? 'LEASH ON' : 'LEASH OFF')}  ${c.dim(`task: ${TASK}`)}`);
  await runAgent({
    task: TASK, guarded, style: 'redteam', guard,
    emit: (e) => {
      if (e.type === 'thought') console.log(c.dim('  agent: ' + e.text));
      if (e.type === 'decision') {
        const d = e.decision;
        const tag = d.verdict === 'blocked' ? c.green('BLOCKED ') : d.verdict === 'needs_approval' ? c.amber('ASK YOU ') : d.verdict === 'unguarded' ? c.red('PAID    ') : c.green('PAID    ');
        console.log(`  ${tag} ${d.summary}`);
        if (d.verdict !== 'unguarded') console.log(c.dim(`           ${d.reasons[0]}`));
      }
    },
  });
  const moved = store.decisions.filter((d) => d.status === 'paid').reduce((s, d) => s + d.request.amount, 0);
  console.log(guarded ? c.green(`  Money moved: $${moved.toFixed(2)}`) : c.red(`  Money moved: $${moved.toFixed(2)} (including the $200 to a stranger)`));
}

console.log(c.dim(`PayPal: ${config.paypalMode}`));
await scenario(false);
await scenario(true);
