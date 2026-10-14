// Tiny JSON-file store: policy, decisions (the audit log) and spend ledger.
// Zero native deps so judges can `npm install && npm start`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_POLICY = Object.freeze({
  text: 'Max $50 per purchase and $200 a month. Only electronics and books. Ask me before anything over $30. No transfers to people.',
  currency: 'USD',
  maxPerPurchase: 50,
  approvalAbove: 30,
  dailyLimit: null,
  monthlyLimit: 200,
  maxTransactionsPerHour: 6,
  allowedCategories: ['electronics', 'books'],
  allowedMerchants: [],
  blockedMerchants: [],
  allowTransfers: false,
  allowedRecipients: [],
});

export const uid = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

export class Store {
  /** @param {string|null} file  null = memory only (tests) */
  constructor(file = null) {
    this.file = file;
    this.state = { policy: { ...DEFAULT_POLICY }, decisions: [] };
    if (file && fs.existsSync(file)) {
      try { this.state = { ...this.state, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* corrupt file: start fresh */ }
    }
  }

  _save() {
    if (!this.file) return;
    clearTimeout(this._t);
    this._t = setTimeout(() => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    }, 150);
  }

  get policy() { return this.state.policy; }
  setPolicy(p) { this.state.policy = p; this._save(); return p; }

  addDecision(d) {
    const rec = { id: uid('dec'), ts: new Date().toISOString(), ...d };
    this.state.decisions.unshift(rec);
    this.state.decisions = this.state.decisions.slice(0, 500);
    this._save();
    return rec;
  }
  getDecision(id) { return this.state.decisions.find((d) => d.id === id); }
  findDecision(fn) { return this.state.decisions.find(fn); }
  updateDecision(id, patch) {
    const d = this.getDecision(id);
    if (!d) return null;
    Object.assign(d, patch, { updatedAt: new Date().toISOString() });
    this._save();
    return d;
  }
  get decisions() { return this.state.decisions; }

  /** Money that actually left (or is committed) — only decisions that were paid. */
  _spentSince(ms, now = Date.now()) {
    return this.state.decisions
      .filter((d) => d.status === 'paid' && d.verdict !== 'unguarded' && now - Date.parse(d.paidAt || d.ts) < ms)
      .reduce((s, d) => s + d.request.amount, 0);
  }
  spentToday(now) { return this._spentSince(24 * 3600e3, now); }
  spentMonth(now) { return this._spentSince(30 * 24 * 3600e3, now); }
  countLastHour(now = Date.now()) {
    return this.state.decisions.filter(
      (d) => d.verdict !== 'unguarded' && now - Date.parse(d.ts) < 3600e3 && d.request.kind === 'purchase',
    ).length;
  }

  reset() {
    this.state = { policy: this.state.policy, decisions: [] };
    this._save();
  }
}
