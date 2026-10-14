// PayPal client. Two modes:
//   sandbox — real calls to the PayPal REST API (Orders v2, Payouts, Webhooks)
//   mock    — PayPal-shaped responses generated locally (offline demo, tests)
//
// How Leash uses PayPal:
//   * Payouts API      — autonomous agent spend that passes policy (agent wallet -> merchant)
//   * Orders v2 API    — purchases needing human approval: the human is the payer and approves
//                        in PayPal's own checkout; we capture only after that approval
//   * Webhooks         — PAYMENT.CAPTURE.COMPLETED / PAYMENT.PAYOUTSBATCH.* update the audit log
import crypto from 'node:crypto';
import { config } from './config.js';

const fmt = (n) => Number(n).toFixed(2);

export class PayPalError extends Error {
  constructor(message, { status, debugId, details } = {}) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.debugId = debugId;
    this.details = details;
  }
}

export class PayPal {
  constructor(cfg = config) {
    this.cfg = cfg;
    this.mode = cfg.paypalMode;
    this._token = null;
    this._tokenExp = 0;
    this.mockOrders = new Map();
  }

  // ---------- auth + transport (sandbox) ----------
  async _accessToken() {
    if (this._token && Date.now() < this._tokenExp - 30_000) return this._token;
    const { clientId, secret, apiBase } = this.cfg.paypal;
    const res = await fetch(`${apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new PayPalError('PayPal auth failed', { status: res.status, details: json });
    this._token = json.access_token;
    this._tokenExp = Date.now() + json.expires_in * 1000;
    return this._token;
  }

  async _call(method, path, body, extraHeaders = {}) {
    const token = await this._accessToken();
    const res = await fetch(`${this.cfg.paypal.apiBase}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new PayPalError(json.message || `PayPal ${method} ${path} failed (${res.status})`, {
        status: res.status,
        debugId: json.debug_id,
        details: json.details,
      });
    }
    return json;
  }

  // ---------- Orders v2: human-approved purchases ----------
  async createOrder({ amount, currency = 'USD', description, referenceId, requestId }) {
    if (this.mode === 'mock') {
      const id = `MOCKORDER${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      const order = { id, status: 'PAYER_ACTION_REQUIRED', amount: fmt(amount), currency, description };
      this.mockOrders.set(id, order);
      return { id, status: order.status, approveUrl: `${this.cfg.baseUrl}/mock/paypal/approve?token=${id}` };
    }
    const json = await this._call(
      'POST',
      '/v2/checkout/orders',
      {
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: referenceId,
            description: String(description).slice(0, 127),
            amount: { currency_code: currency, value: fmt(amount) },
            payee: this.cfg.paypal.merchantEmail ? { email_address: this.cfg.paypal.merchantEmail } : undefined,
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'Leash',
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
              return_url: `${this.cfg.baseUrl}/paypal/return`,
              cancel_url: `${this.cfg.baseUrl}/paypal/cancel`,
            },
          },
        },
      },
      { 'PayPal-Request-Id': requestId },
    );
    const link = (json.links || []).find((l) => ['payer-action', 'approve'].includes(l.rel));
    return { id: json.id, status: json.status, approveUrl: link?.href };
  }

  async captureOrder(orderId) {
    if (this.mode === 'mock') {
      const o = this.mockOrders.get(orderId);
      if (!o) throw new PayPalError('Unknown mock order', { status: 404 });
      o.status = 'COMPLETED';
      return { id: orderId, status: 'COMPLETED', captureId: `MOCKCAP${orderId.slice(-6)}`, amount: o.amount };
    }
    const json = await this._call('POST', `/v2/checkout/orders/${orderId}/capture`, undefined, {
      'PayPal-Request-Id': `capture-${orderId}`,
    });
    const cap = json.purchase_units?.[0]?.payments?.captures?.[0];
    return { id: json.id, status: json.status, captureId: cap?.id, amount: cap?.amount?.value };
  }

  // ---------- Payouts: autonomous spend that passed policy ----------
  async sendPayout({ email, amount, currency = 'USD', note, itemId }) {
    if (this.mode === 'mock') {
      return { batchId: `MOCKBATCH${crypto.randomBytes(5).toString('hex').toUpperCase()}`, status: 'SUCCESS' };
    }
    const json = await this._call(
      'POST',
      '/v1/payments/payouts',
      {
        sender_batch_header: {
          sender_batch_id: itemId,
          email_subject: 'Payment from your Leash agent wallet',
          email_message: String(note || '').slice(0, 200),
        },
        items: [
          {
            recipient_type: 'EMAIL',
            receiver: email,
            amount: { value: fmt(amount), currency },
            note: String(note || '').slice(0, 160),
            sender_item_id: itemId,
          },
        ],
      },
      { 'PayPal-Request-Id': itemId },
    );
    return { batchId: json.batch_header?.payout_batch_id, status: json.batch_header?.batch_status || 'PENDING' };
  }

  // ---------- Webhooks ----------
  async verifyWebhook(headers, rawBody) {
    if (this.mode === 'mock') return true; // mock events come from our own simulator
    if (!this.cfg.paypal.webhookId) return false;
    const h = (k) => headers[k] || headers[k.toLowerCase()];
    const res = await this._call('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: this.cfg.paypal.webhookId,
      webhook_event: JSON.parse(rawBody),
    });
    return res.verification_status === 'SUCCESS';
  }
}
