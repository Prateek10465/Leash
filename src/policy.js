// Policy = plain English -> structured rules -> deterministic evaluation.
// The LLM only *compiles* the policy (and the user confirms the result). Enforcement is plain code,
// so a prompt-injected model can never talk its way past a spending cap.
import { DEFAULT_POLICY } from './store.js';
import { llmAvailable, askJSON } from './llm.js';

export const KNOWN_CATEGORIES = [
  'electronics', 'books', 'home', 'clothing', 'software', 'groceries', 'toys', 'sports', 'gift-cards', 'office',
];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const strList = (v) => (Array.isArray(v) ? [...new Set(v.map((s) => String(s).trim().toLowerCase()).filter(Boolean))] : []);

/** Validate + clamp anything (LLM output included) into a safe policy object. */
export function normalizePolicy(raw = {}, text = '') {
  const p = {
    text: text || raw.text || '',
    currency: String(raw.currency || 'USD').toUpperCase().slice(0, 3),
    maxPerPurchase: num(raw.maxPerPurchase),
    approvalAbove: num(raw.approvalAbove),
    dailyLimit: num(raw.dailyLimit),
    monthlyLimit: num(raw.monthlyLimit),
    maxTransactionsPerHour: Math.round(num(raw.maxTransactionsPerHour) ?? DEFAULT_POLICY.maxTransactionsPerHour),
    allowedCategories: strList(raw.allowedCategories),
    allowedMerchants: strList(raw.allowedMerchants),
    blockedMerchants: strList(raw.blockedMerchants),
    allowTransfers: raw.allowTransfers === true,
    allowedRecipients: strList(raw.allowedRecipients),
  };
  // An approval threshold above the hard cap is meaningless: everything over the cap is denied anyway.
  if (p.approvalAbove && p.maxPerPurchase && p.approvalAbove > p.maxPerPurchase) p.approvalAbove = p.maxPerPurchase;
  return p;
}

// ---------- compile: natural language -> rules ----------
function firstNumber(text, regexes) {
  for (const re of regexes) {
    const m = text.match(re);
    if (m) {
      const v = m.slice(1).find((g) => g !== undefined);
      if (v !== undefined) return Number(v.replace(/,/g, ''));
    }
  }
  return null;
}
const AMT = '\\$?\\s?(\\d[\\d,]*(?:\\.\\d+)?)';

export function heuristicCompile(text) {
  const t = ` ${text} `;
  const raw = {
    maxPerPurchase: firstNumber(t, [
      new RegExp(`${AMT}\\s*(?:usd|dollars)?\\s*(?:per|a|each|/)\\s*(?:purchase|order|item|transaction|buy)`, 'i'),
      new RegExp(`(?:max(?:imum)?|cap(?:ped)? at|no (?:single )?(?:purchase|order) (?:over|above))\\s*(?:per (?:purchase|order))?\\s*(?:of)?\\s*${AMT}`, 'i'),
    ]),
    monthlyLimit: firstNumber(t, [
      new RegExp(`${AMT}\\s*(?:usd|dollars)?\\s*(?:per|a|each|/|every)\\s*month`, 'i'),
      new RegExp(`monthly\\s*(?:limit|budget|cap|spend(?:ing)?)\\s*(?:of|is|:)?\\s*${AMT}`, 'i'),
    ]),
    dailyLimit: firstNumber(t, [
      new RegExp(`${AMT}\\s*(?:usd|dollars)?\\s*(?:per|a|each|/|every)\\s*day`, 'i'),
      new RegExp(`daily\\s*(?:limit|budget|cap)\\s*(?:of|is|:)?\\s*${AMT}`, 'i'),
    ]),
    approvalAbove: firstNumber(t, [
      new RegExp(`(?:ask|check|confirm|approv\\w*|ping|prompt)[^.;]*?(?:over|above|more than|exceeding|beyond)\\s*${AMT}`, 'i'),
      new RegExp(`(?:over|above|more than)\\s*${AMT}[^.;]*?(?:ask|check|confirm|approv\\w*)`, 'i'),
    ]),
    allowTransfers: /\ballow\w*\s+(?:transfers|p2p|payments? to (?:people|friends))/i.test(t) && !/\b(?:no|don'?t|never|block)\b[^.;]*transfer/i.test(t),
  };
  // categories: only trust a list that follows "only"/"just"/"stick to"
  const sentence = t.match(/(?:only|just|stick to|limited to)\s+([^.;]*)/i)?.[1] || '';
  raw.allowedCategories = KNOWN_CATEGORIES.filter((c) => new RegExp(`\\b${c.replace('-', '[- ]?')}s?\\b`, 'i').test(sentence));
  return normalizePolicy(raw, text);
}

const COMPILER_SYSTEM = `You compile a person's plain-English spending rules for an AI shopping agent into JSON.
Reply with ONE JSON object and nothing else. Fields (use null / [] / false when the person did not specify):
{
 "currency": "USD",
 "maxPerPurchase": number|null,      // hard cap on a single purchase; above it is denied
 "approvalAbove": number|null,       // purchases above this need the human's approval (must be <= maxPerPurchase)
 "dailyLimit": number|null,
 "monthlyLimit": number|null,
 "maxTransactionsPerHour": number|null,
 "allowedCategories": string[],      // lowercase, from: ${KNOWN_CATEGORIES.join(', ')}. [] = any category
 "allowedMerchants": string[],       // merchant ids/domains; [] = any
 "blockedMerchants": string[],
 "allowTransfers": boolean,          // paying individuals (not merchants); default false
 "allowedRecipients": string[]       // emails allowed when transfers are on
}
Be conservative: if unsure, choose the stricter reading. Never invent limits the person did not state.`;

export async function compilePolicy(text) {
  const clean = String(text || '').slice(0, 2000);
  if (llmAvailable()) {
    try {
      const raw = await askJSON({ system: COMPILER_SYSTEM, user: clean });
      return { policy: normalizePolicy(raw, clean), method: 'llm' };
    } catch (e) {
      return { policy: heuristicCompile(clean), method: 'heuristic', warning: `LLM compile failed (${e.message}); used rule parser.` };
    }
  }
  return { policy: heuristicCompile(clean), method: 'heuristic' };
}

// ---------- evaluate: deterministic enforcement ----------
/**
 * @param policy  normalized policy
 * @param req     { kind, amount, currency, category, merchantId, merchantName, payeeEmail }
 * @param ctx     { spentToday, spentMonth, txLastHour }
 * @returns { verdict: 'allow'|'approve'|'deny', checks: [{rule,label,pass,detail,effect}], failures: string[], approvals: string[] }
 */
export function evaluatePolicy(policy, req, ctx = {}) {
  const checks = [];
  // fail = the sentence shown in the audit log when this check trips
  const add = (rule, label, pass, detail, effect, fail) => checks.push({ rule, label, pass, detail, effect, fail });
  const usd = (n) => `$${Number(n).toFixed(2)}`;
  const merchant = String(req.merchantId || req.merchantName || '').toLowerCase();
  const recipient = String(req.payeeEmail || '').toLowerCase();

  add('valid_amount', 'Amount is a positive number', Number.isFinite(req.amount) && req.amount > 0, usd(req.amount), 'deny', `Invalid amount (${req.amount})`);
  add('currency', `Currency is ${policy.currency}`, (req.currency || 'USD') === policy.currency, req.currency || 'USD', 'deny', `Currency ${req.currency} is not ${policy.currency}`);

  if (req.kind === 'transfer') {
    const ok = policy.allowTransfers && policy.allowedRecipients.includes(recipient);
    add('transfers', 'Transfers to individuals are permitted', ok, recipient, 'deny',
      policy.allowTransfers ? `${recipient} is not on your allowed-recipient list` : 'Your policy blocks transfers to individuals');
  } else {
    if (policy.blockedMerchants.length) add('blocked_merchant', 'Merchant is not blocked', !policy.blockedMerchants.includes(merchant), merchant, 'deny', `${merchant} is on your block list`);
    if (policy.allowedMerchants.length) add('allowed_merchant', 'Merchant is on the allow-list', policy.allowedMerchants.includes(merchant), merchant, 'deny', `${merchant} is not on your allowed-merchant list`);
    if (policy.allowedCategories.length) {
      const cat = String(req.category || 'unknown').toLowerCase();
      add('category', `Category is allowed (${policy.allowedCategories.join(', ')})`, policy.allowedCategories.includes(cat), cat, 'deny', `Category "${cat}" is outside your allowed categories`);
    }
  }

  if (policy.maxPerPurchase) add('max_per_purchase', `Within ${usd(policy.maxPerPurchase)} per-payment cap`, req.amount <= policy.maxPerPurchase, usd(req.amount), 'deny', `${usd(req.amount)} is over your ${usd(policy.maxPerPurchase)} per-payment cap`);
  if (policy.dailyLimit) {
    const after = (ctx.spentToday || 0) + req.amount;
    add('daily_limit', `Within ${usd(policy.dailyLimit)} daily limit`, after <= policy.dailyLimit, `${usd(after)} after this payment`, 'deny', `Would bring today's spend to ${usd(after)}, over your ${usd(policy.dailyLimit)} daily limit`);
  }
  if (policy.monthlyLimit) {
    const after = (ctx.spentMonth || 0) + req.amount;
    add('monthly_limit', `Within ${usd(policy.monthlyLimit)} monthly limit`, after <= policy.monthlyLimit, `${usd(after)} after this payment`, 'deny', `Would bring this month's spend to ${usd(after)}, over your ${usd(policy.monthlyLimit)} limit`);
  }
  if (policy.maxTransactionsPerHour) {
    add('velocity', `At most ${policy.maxTransactionsPerHour} purchases per hour`, (ctx.txLastHour || 0) < policy.maxTransactionsPerHour, `${ctx.txLastHour || 0} in the last hour`, 'deny', `Too many purchases in an hour (limit ${policy.maxTransactionsPerHour})`);
  }
  if (policy.approvalAbove) {
    add('approval_threshold', `Auto-approved up to ${usd(policy.approvalAbove)}`, req.amount <= policy.approvalAbove, usd(req.amount), 'approve', `${usd(req.amount)} is over your ${usd(policy.approvalAbove)} auto-approve limit, so it needs your OK`);
  }

  const failed = checks.filter((c) => !c.pass);
  const denies = failed.filter((c) => c.effect === 'deny');
  const approvals = failed.filter((c) => c.effect === 'approve');
  return {
    verdict: denies.length ? 'deny' : approvals.length ? 'approve' : 'allow',
    checks,
    failures: denies.map((c) => c.fail),
    approvals: approvals.map((c) => c.fail),
  };
}
