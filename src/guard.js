// The guard sits between an AI agent and the money. Every payment attempt goes through authorize():
//   1. deterministic policy check   (caps, categories, velocity, transfers)
//   2. injection judge              (does this match what the human asked for?)
//   3. decision                     allowed -> PayPal Payout | needs_approval -> PayPal Order | blocked -> nothing moves
// Every attempt, allowed or not, lands in the audit log with the full reasoning for replay.
import { evaluatePolicy } from './policy.js';
import { judgeRequest } from './judge.js';

export function normalizeRequest(r) {
  return {
    kind: r.kind === 'transfer' ? 'transfer' : 'purchase',
    amount: Math.round(Number(r.amount) * 100) / 100,
    currency: String(r.currency || 'USD').toUpperCase(),
    item: r.item ? String(r.item).slice(0, 140) : undefined,
    category: r.category ? String(r.category).toLowerCase() : undefined,
    productId: r.productId,
    merchantId: r.merchantId,
    merchantName: r.merchantName,
    merchantEmail: r.merchantEmail,
    payeeEmail: r.payeeEmail ? String(r.payeeEmail).toLowerCase() : undefined,
    memo: r.memo ? String(r.memo).slice(0, 140) : undefined,
  };
}

const top = (list, n = 2) => list.slice(0, n).join('; ') + (list.length > n ? `; and ${list.length - n} more signals` : '');
const describe = (req) =>
  req.kind === 'transfer' ? `transfer $${req.amount.toFixed(2)} to ${req.payeeEmail}` : `buy "${req.item}" for $${req.amount.toFixed(2)} from ${req.merchantName || req.merchantId}`;

export class Guard {
  constructor({ store, paypal, judge = judgeRequest, now = () => Date.now() }) {
    Object.assign(this, { store, paypal, judge, now });
  }

  _ctx() {
    const t = this.now();
    return { spentToday: this.store.spentToday(t), spentMonth: this.store.spentMonth(t), txLastHour: this.store.countLastHour(t) };
  }

  /** Decide, and (if allowed) pay. Never throws on a blocked payment: returns the decision record. */
  async authorize(input, { task = '', evidence = [], runId, agent = 'agent' } = {}) {
    const request = normalizeRequest(input);
    const policy = this.store.policy;
    const pol = evaluatePolicy(policy, request, this._ctx());
    const judge = await this.judge({ task, request, evidence });

    const reasons = [];
    let verdict = 'allowed';
    let blockedBy;
    if (pol.verdict === 'deny' || judge.verdict === 'suspicious') {
      verdict = 'blocked';
      blockedBy = pol.verdict === 'deny' && judge.verdict === 'suspicious' ? 'policy+judge' : pol.verdict === 'deny' ? 'policy' : 'judge';
      reasons.push(...pol.failures);
      if (judge.verdict === 'suspicious') reasons.push(`Injection suspected (risk ${judge.risk}): ${top(judge.reasons) || 'payment does not match the request'}`);
    } else if (pol.verdict === 'approve' || judge.verdict === 'uncertain') {
      verdict = 'needs_approval';
      reasons.push(...pol.approvals);
      if (judge.verdict === 'uncertain') reasons.push(`Reviewer unsure (risk ${judge.risk}): ${top(judge.reasons)}`);
    } else {
      reasons.push('Within policy and consistent with the request');
    }

    const rec = this.store.addDecision({
      runId, agent, task, request, summary: describe(request),
      policyChecks: pol.checks, judge, evidence: evidence.map((e) => ({ source: e.source, text: String(e.text).slice(0, 2000) })),
      verdict, blockedBy, reasons, status: verdict === 'blocked' ? 'blocked' : 'processing', events: [],
    });

    try {
      if (verdict === 'allowed') await this._pay(rec);
      else if (verdict === 'needs_approval') await this._openApproval(rec);
    } catch (e) {
      this.store.updateDecision(rec.id, { status: 'failed', error: `${e.name}: ${e.message}`, debugId: e.debugId });
    }
    return this.store.getDecision(rec.id);
  }

  /** Autonomous spend that passed policy: PayPal Payouts. */
  async _pay(rec) {
    const r = rec.request;
    const email = r.kind === 'transfer' ? r.payeeEmail : this._merchantEmail(r);
    const out = await this.paypal.sendPayout({ email, amount: r.amount, currency: r.currency, note: r.memo || r.item || 'Leash payment', itemId: rec.id });
    this.store.updateDecision(rec.id, { status: 'paid', paidAt: new Date().toISOString(), payment: { type: 'payout', batchId: out.batchId, status: out.status, email } });
  }

  /** Needs a human: create a PayPal order; the human approves in PayPal checkout, we capture afterwards. */
  async _openApproval(rec) {
    const r = rec.request;
    const order = await this.paypal.createOrder({
      amount: r.amount, currency: r.currency, description: r.item || r.memo || 'Agent purchase', referenceId: rec.id, requestId: rec.id,
    });
    this.store.updateDecision(rec.id, { status: 'pending_approval', payment: { type: 'order', orderId: order.id, approveUrl: order.approveUrl, status: order.status } });
  }

  _merchantEmail(r) { return r.merchantEmail || this.paypal.cfg.paypal.merchantEmail; }

  /** Called when the human returns from PayPal checkout. */
  async completeApproval(orderId) {
    const rec = this.store.findDecision((d) => d.payment?.orderId === orderId);
    if (!rec) return null;
    if (rec.status === 'paid') return rec;
    if (rec.status !== 'pending_approval') return rec;
    try {
      const cap = await this.paypal.captureOrder(orderId);
      return this.store.updateDecision(rec.id, {
        status: cap.status === 'COMPLETED' ? 'paid' : 'failed',
        paidAt: new Date().toISOString(),
        approvedBy: 'human',
        payment: { ...rec.payment, status: cap.status, captureId: cap.captureId },
      });
    } catch (e) {
      return this.store.updateDecision(rec.id, { status: 'failed', error: `${e.name}: ${e.message}`, debugId: e.debugId });
    }
  }

  reject(id) {
    const rec = this.store.getDecision(id);
    if (!rec || rec.status !== 'pending_approval') return rec || null;
    return this.store.updateDecision(id, { status: 'rejected', rejectedBy: 'human' });
  }

  /** Baseline for the demo: what happens with NO firewall. Pays whatever the agent asks. */
  async executeUnguarded(input, { task = '', runId, agent = 'agent' } = {}) {
    const request = normalizeRequest(input);
    const rec = this.store.addDecision({
      runId, agent, task, request, summary: describe(request), verdict: 'unguarded', status: 'processing',
      reasons: ['Leash was off, so no checks ran'], policyChecks: [], judge: null, evidence: [], events: [],
    });
    try {
      await this._pay(rec);
    } catch (e) {
      this.store.updateDecision(rec.id, { status: 'failed', error: e.message });
    }
    return this.store.getDecision(rec.id);
  }

  /** PayPal webhook events -> audit log. Idempotent. */
  handleWebhook(event) {
    const type = event?.event_type;
    const res = event?.resource || {};
    let rec;
    if (type?.startsWith('PAYMENT.CAPTURE')) {
      const orderId = res.supplementary_data?.related_ids?.order_id;
      rec = this.store.findDecision((d) => d.payment?.orderId === orderId);
    } else if (type?.startsWith('PAYMENT.PAYOUTS')) {
      const itemId = res.payout_item?.sender_item_id || res.sender_item_id;
      rec = this.store.getDecision(itemId) || this.store.findDecision((d) => d.payment?.batchId && d.payment.batchId === (res.payout_batch_id || res.batch_header?.payout_batch_id));
    }
    if (!rec) return null;
    if (rec.events.some((e) => e.id === event.id)) return rec; // already processed
    const patch = { events: [...rec.events, { id: event.id, type, at: new Date().toISOString() }] };
    if (/COMPLETED|SUCCESS|SUCCEEDED/.test(type)) patch.status = 'paid';
    if (/DENIED|FAILED|RETURNED|BLOCKED|UNCLAIMED/.test(type) && rec.verdict !== 'blocked') patch.status = 'failed';
    return this.store.updateDecision(rec.id, patch);
  }
}
