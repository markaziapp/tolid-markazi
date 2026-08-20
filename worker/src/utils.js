// ===================================================================
// ابزارهای کمکی مشترک
// ===================================================================

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Setup-Key',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      ...extraHeaders,
    },
  });
}

export function error(message, status = 400) {
  return json({ error: message }, status);
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// تولید یک شناسه تصادفی کوتاه برای نام فایل‌های آپلودی در R2
export function randomKey(prefix, ext) {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `${prefix}/${Date.now()}-${rand}${ext ? '.' + ext : ''}`;
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}
