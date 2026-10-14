// Minimal Anthropic Messages API client (plain fetch, no SDK).
// Everything in Leash degrades gracefully when no key is set: policy compilation and the
// injection judge fall back to deterministic heuristics, so the demo still runs offline.
import { config } from './config.js';

export const llmAvailable = () => Boolean(config.anthropicKey);

export async function messages({ system, messages: msgs, tools, maxTokens = 1024, model = config.model }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: msgs, ...(tools ? { tools } : {}) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${json?.error?.message || 'request failed'}`);
  return json;
}

/** Pull the first JSON object out of a model reply (tolerates prose / code fences). */
export function extractJSON(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object in reply');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object in reply');
}

export async function askJSON({ system, user, maxTokens = 800 }) {
  const out = await messages({ system, messages: [{ role: 'user', content: user }], maxTokens });
  const text = out.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return extractJSON(text);
}
