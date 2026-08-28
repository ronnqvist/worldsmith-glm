import { log } from '../core/log.js';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const KEY_ENDPOINT = 'https://openrouter.ai/api/v1/auth/key';
const MAX_TOKENS = 16384;
const MAX_TOKENS_FALLBACK = 8192;

export class LlmError extends Error {}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function headers({ apiKey, referer, title }) {
  const h = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };
  if (referer) h['HTTP-Referer'] = referer;
  if (title) h['X-Title'] = title;
  return h;
}

function buildBody({ model, messages, useResponseFormat = true, maxTokens = MAX_TOKENS }) {
  const body = {
    model,
    messages,
    temperature: 0.7,
    max_tokens: maxTokens
  };
  if (useResponseFormat) body.response_format = { type: 'json_object' };
  return body;
}

async function readErrorDetail(res) {
  try {
    const data = await res.json();
    return (data.error && (data.error.message || data.error.code)) || JSON.stringify(data).slice(0, 300);
  } catch {
    return '';
  }
}

// Single request with one 429/5xx retry; resolves with parsed JSON or throws
// LlmError with a user-facing message for hard failures.
async function requestOnce(url, options, { maxAttempts = 2 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(800 * Math.pow(2, attempt - 1));
    let res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      lastErr = new LlmError('Cannot reach OpenRouter (network error)');
      continue;
    }
    if (res.ok) return res.json();
    const detail = await readErrorDetail(res);
    if (res.status === 401 || res.status === 403) {
      throw new LlmError('OpenRouter rejected your key');
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new LlmError('OpenRouter is busy, try again');
      continue;
    }
    const err = new LlmError(`OpenRouter error ${res.status}${detail ? ': ' + detail : ''}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  throw lastErr || new LlmError('OpenRouter request failed');
}

// Aggressive JSON recovery: strip fences, then take the first balanced {...}.
function extractJson(text) {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through */ }
  const start = trimmed.indexOf('{');
  if (start === -1) throw new LlmError('The model returned no JSON object');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { if (inStr) esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(trimmed.slice(start, i + 1));
      }
    }
  }
  throw new LlmError('The model returned truncated or malformed JSON');
}

function validateEnvelope(obj) {
  if (!obj || typeof obj !== 'object') throw new LlmError('The model returned an invalid world (not an object)');
  if (obj.action !== 'create_world' && obj.action !== 'update_world') {
    throw new LlmError(`The model returned an invalid world (bad action "${obj.action}")`);
  }
  if (typeof obj.markup !== 'string') {
    throw new LlmError('The model returned an invalid world (markup missing)');
  }
  if (obj.removed_ids !== undefined && !Array.isArray(obj.removed_ids)) {
    throw new LlmError('The model returned an invalid world (removed_ids)');
  }
  return {
    action: obj.action,
    markup: obj.markup,
    removed_ids: Array.isArray(obj.removed_ids) ? obj.removed_ids : [],
    narration: typeof obj.narration === 'string' ? obj.narration : ''
  };
}

// Runs the retry/parse matrix from the plan:
//  - finish_reason "length"  -> immediate "world too large" error
//  - 429/5xx                 -> handled inside requestOnce (one retry, backoff)
//  - 400 re max_tokens       -> retry once with a lower cap
//  - 400 re response_format OR unparseable content -> retry once without response_format
export async function chatCompletion({ apiKey, model, messages, referer, title }) {
  if (!apiKey) throw new LlmError('Add your OpenRouter API key in Settings first');
  const opts = { apiKey, referer, title };
  const baseBody = { model, messages };
  const doFetch = (body) => requestOnce(ENDPOINT, {
    method: 'POST',
    headers: headers(opts),
    body: JSON.stringify(body)
  });

  let data;
  try {
    data = await doFetch(buildBody(baseBody));
  } catch (e) {
    if (e.status === 400 && /max_tokens/i.test(e.detail || '')) {
      data = await doFetch(buildBody({ ...baseBody, maxTokens: MAX_TOKENS_FALLBACK }));
    } else if (e.status === 400 && /response_format|json_object/i.test(e.detail || '')) {
      data = await doFetch(buildBody({ ...baseBody, useResponseFormat: false }));
    } else {
      throw e;
    }
  }

  let choice = data && data.choices && data.choices[0];
  if (choice && choice.finish_reason === 'length') {
    throw new LlmError('World too large for one response - try a smaller change or add fewer things at once');
  }

  let content = choice && choice.message && choice.message.content;
  let parsed = null;
  try {
    parsed = extractJson(content);
  } catch (e) {
    // One retry without response_format (some providers ignore or reject it)
    log.warn('JSON parse failed, retrying without response_format');
    data = await doFetch(buildBody({ ...baseBody, useResponseFormat: false }));
    choice = data && data.choices && data.choices[0];
    if (choice && choice.finish_reason === 'length') {
      throw new LlmError('World too large for one response - try a smaller change or add fewer things at once');
    }
    content = choice && choice.message && choice.message.content;
    parsed = extractJson(content);
  }
  return validateEnvelope(parsed);
}

export async function validateKey({ apiKey, referer, title }) {
  if (!apiKey) return { ok: false, message: 'No key set' };
  try {
    const res = await fetch(KEY_ENDPOINT, { headers: headers({ apiKey, referer, title }) });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const label = data && data.data && data.data.label ? ` (${data.data.label})` : '';
      return { ok: true, message: 'Key valid' + label };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'OpenRouter rejected your key' };
    return { ok: false, message: `OpenRouter error ${res.status}` };
  } catch {
    return { ok: false, message: 'Cannot reach OpenRouter' };
  }
}
