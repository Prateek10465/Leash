// Central config. Reads .env if present (Node >= 20.12), then process.env.
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch { /* no .env, fine */ }

const env = process.env;
const port = Number(env.PORT || 3000);

export const config = {
  port,
  baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  paypal: {
    clientId: env.PAYPAL_CLIENT_ID || '',
    secret: env.PAYPAL_CLIENT_SECRET || '',
    webhookId: env.PAYPAL_WEBHOOK_ID || '',
    apiBase: env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com',
    // Email of the sandbox account that plays "the merchant" for demo purchases.
    merchantEmail: env.LEASH_MERCHANT_EMAIL || 'sb-merchant@business.example.com',
  },
  // mock = no network calls to PayPal; PayPal-shaped responses generated locally.
  paypalMode:
    env.PAYPAL_MODE === 'mock' || !(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET)
      ? 'mock'
      : 'sandbox',
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  model: env.LEASH_MODEL || 'claude-haiku-5-5',
  channel3Key: env.CHANNEL3_API_KEY || '',
  dataFile: env.LEASH_DATA || fileURLToPath(new URL('../data/leash.json', import.meta.url)),
};

