// ===================================================================
// توابع احراز هویت: هش کردن رمز عبور + صدور/بررسی توکن نشست
// فقط با Web Crypto داخلی Cloudflare Workers، بدون هیچ کتابخانه خارجی
// ===================================================================

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes.buffer;
}

// --- هش رمز عبور با PBKDF2 ---
export async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = saltHex ? hexToBuf(saltHex) : crypto.getRandomValues(new Uint8Array(16)).buffer;
  const saltHexOut = saltHex || bufToHex(salt);
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return `${saltHexOut}:${bufToHex(bits)}`;
}

export async function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [saltHex] = stored.split(':');
  const recomputed = await hashPassword(password, saltHex);
  return recomputed === stored;
}

// --- توکن نشست امضاشده با HMAC-SHA256 (بدون نیاز به ذخیره سِشن در دیتابیس) ---
async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signToken(payload, secret, expiresInSeconds = 60 * 60 * 24 * 7) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + expiresInSeconds };
  const json = JSON.stringify(body);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(b64));
  return `${b64}.${bufToHex(sig)}`;
}

export async function verifyToken(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [b64, sigHex] = token.split('.');
  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify('HMAC', key, hexToBuf(sigHex), new TextEncoder().encode(b64));
  if (!valid) return null;
  try {
    const payload = JSON.parse(decodeURIComponent(escape(atob(b64))));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getBearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

// --- محدودیت تلاش ورود (ضد حدس‌زدن رمز) ---
export async function tooManyAttempts(db, scope, identifier, ip) {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const row = await db.prepare(
    `SELECT COUNT(*) as c FROM login_attempts WHERE scope=? AND (identifier=? OR ip=?) AND success=0 AND created_at > ?`
  ).bind(scope, identifier, ip || '', since).first();
  return (row?.c || 0) >= 8;
}

export async function recordAttempt(db, scope, identifier, ip, success) {
  await db.prepare(`INSERT INTO login_attempts (scope, identifier, ip, success) VALUES (?,?,?,?)`)
    .bind(scope, identifier, ip || '', success ? 1 : 0).run();
}
