// ===================================================================
// ماژول «دستیار اداری همتا صنعت»
// واحدها مکاتبه/کار اداری خود را ثبت می‌کنند (کد رهگیری می‌گیرند)،
// مدیر پلتفرم پیگیری می‌کند، به ادارات ارجاع می‌دهد و پاسخ را برمی‌گرداند.
// هزینه: اشتراک (ماهانه/۶ماهه/سالانه) یا نرخ هر خدمت — همه از پنل مدیریت قابل ویرایش.
//
// این فایل مستقل است و فقط با دو خط در index.js فعال می‌شود:
//   import { registerCorrRoutes } from './corr.js';
//   registerCorrRoutes(router, { requireAdmin, requireCompany, notifyCompany, clientIp });
// ===================================================================
import { json, error, readJson } from './utils.js';
import { hashPassword, verifyPassword, signToken, verifyToken, getBearerToken, tooManyAttempts, recordAttempt } from './auth.js';

// ---------------------- ثابت‌ها ----------------------
export const CORR_STATUSES = ['ثبت شد', 'در حال بررسی', 'ارجاع شد', 'پاسخ اداره دریافت شد', 'پاسخ ارسال شد', 'انجام شد', 'لغو شد'];
const PAYMENT_STATUSES = ['none', 'unpaid', 'receipt_sent', 'paid', 'subscription', 'free'];
const PRIORITIES = ['عادی', 'فوری'];
const OFFICE_LEVELS = ['شهرستان', 'کل'];

const SETTING_DEFAULTS = {
  module_enabled: '1',
  intro_title: 'کارهای اداری واحدتان را به همتا صنعت بسپارید',
  intro_text: 'نامه‌نگاری، پیگیری و دریافت پاسخ از ادارات را ثبت کنید؛ کد رهگیری بگیرید و روند کار را لحظه‌به‌لحظه ببینید.',
  card_number: '',
  card_owner: '',
  bank_name: '',
  payment_note: 'پس از واریز، تصویر رسید را بارگذاری کنید تا پس از بررسی تأیید شود.',
  first_request_free: '0',
  allow_without_subscription: '1',
};

// دستورهای ساخت جدول — هر کدام جدا اجرا می‌شود (قابل اجرای مجدد، بدون خطر)
export const CORR_SETUP_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS corr_settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS corr_offices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'شهرستان',
    county TEXT, description TEXT, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS corr_office_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, office_id INTEGER NOT NULL, username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL, full_name TEXT, active INTEGER NOT NULL DEFAULT 1, last_login_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS corr_services (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, price INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS corr_plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, duration_days INTEGER NOT NULL DEFAULT 30,
    price INTEGER NOT NULL DEFAULT 0, included_requests INTEGER NOT NULL DEFAULT 0, badge TEXT,
    active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS corr_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, plan_id INTEGER, plan_title TEXT,
    amount INTEGER NOT NULL DEFAULT 0, included_requests INTEGER NOT NULL DEFAULT 0, requests_used INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending', starts_at TEXT, ends_at TEXT, receipt_url TEXT, receipt_note TEXT, admin_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS corr_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT, tracking_code TEXT NOT NULL UNIQUE, company_id INTEGER NOT NULL,
    office_id INTEGER, office_name TEXT, service_id INTEGER, service_title TEXT,
    subject TEXT NOT NULL, body TEXT, attachments_json TEXT NOT NULL DEFAULT '[]', needs_physical INTEGER NOT NULL DEFAULT 0,
    priority TEXT NOT NULL DEFAULT 'عادی', status TEXT NOT NULL DEFAULT 'ثبت شد',
    billing TEXT NOT NULL DEFAULT 'pay_per_request', fee INTEGER NOT NULL DEFAULT 0, payment_status TEXT NOT NULL DEFAULT 'unpaid',
    receipt_url TEXT, receipt_note TEXT, subscription_id INTEGER,
    referred_office_id INTEGER, referred_office_name TEXT, admin_note TEXT,
    unread_admin INTEGER NOT NULL DEFAULT 1, unread_company INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS corr_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL, actor TEXT NOT NULL, actor_name TEXT,
    kind TEXT NOT NULL DEFAULT 'message', title TEXT, text TEXT, attachments_json TEXT NOT NULL DEFAULT '[]',
    visible_company INTEGER NOT NULL DEFAULT 1, visible_office INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE INDEX IF NOT EXISTS idx_corr_requests_company ON corr_requests(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_corr_requests_status ON corr_requests(status)`,
  `CREATE INDEX IF NOT EXISTS idx_corr_requests_ref ON corr_requests(referred_office_id)`,
  `CREATE INDEX IF NOT EXISTS idx_corr_events_req ON corr_events(request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_corr_subs_company ON corr_subscriptions(company_id)`,
];

// داده‌های نمونهٔ اولیه (فقط اگر جدول خالی باشد) — مدیر همه را از پنل ویرایش می‌کند
const SEED_OFFICES = [
  ['سازمان صنعت، معدن و تجارت استان مرکزی', 'کل', 'اراک'],
  ['شرکت شهرک‌های صنعتی استان مرکزی', 'کل', 'اراک'],
  ['اداره کل حفاظت محیط زیست استان مرکزی', 'کل', 'اراک'],
  ['اداره کل تعاون، کار و رفاه اجتماعی استان مرکزی', 'کل', 'اراک'],
  ['اداره کل امور مالیاتی استان مرکزی', 'کل', 'اراک'],
  ['اداره کل استاندارد استان مرکزی', 'کل', 'اراک'],
  ['شرکت توزیع نیروی برق استان مرکزی', 'کل', 'اراک'],
  ['اداره صنعت، معدن و تجارت شهرستان اراک', 'شهرستان', 'اراک'],
];
const SEED_SERVICES = [
  ['تنظیم و ارسال نامه اداری', 'نگارش، چاپ و ارسال نامه به اداره موردنظر', 0],
  ['پیگیری حضوری نامه و دریافت پاسخ', 'مراجعه حضوری، پیگیری مراحل و دریافت پاسخ', 0],
  ['دریافت یا تحویل مدارک از اداره', 'گرفتن مجوز/گواهی یا تحویل مدارک به اداره', 0],
  ['پیگیری فوری (همان روز)', 'اولویت بالا برای کارهای زمان‌دار', 0],
  ['سایر کارهای اداری (طبق توافق)', 'هر کار اداری دیگر؛ هزینه پس از بررسی اعلام می‌شود', 0],
];
// طرح‌های نمونه — غیرفعال ساخته می‌شوند تا مدیر قیمت واقعی را بگذارد و فعال کند
const SEED_PLANS = [
  ['اشتراک ماهانه', 'مناسب شروع و امتحان سرویس', 30, 1500000, 5, ''],
  ['اشتراک ۶ ماهه', 'مقرون‌به‌صرفه برای واحدهای فعال', 180, 7500000, 40, 'پیشنهاد ویژه'],
  ['اشتراک سالانه', 'بیشترین صرفه؛ پیگیری بدون نگرانی', 365, 12000000, 0, 'بهترین قیمت'],
];

// ---------------------- ابزارهای کمکی ----------------------
const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const addDaysSql = (fromSql, days) => {
  const d = new Date(fromSql.replace(' ', 'T') + 'Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().replace('T', ' ').slice(0, 19);
};
const toInt = (v, def = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : def; };
const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const parseArr = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const cleanUrls = (arr) => (Array.isArray(arr) ? arr : [])
  .map((u) => String(u || '').trim())
  .filter((u) => /^https?:\/\//i.test(u) || u.startsWith('/'))
  .slice(0, 6);
const fa = (n) => Number(n || 0).toLocaleString('fa-IR');

function genTrackingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بدون حروف مشابه (O/0 و I/1)
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return 'HS-' + s;
}

async function getSettings(env) {
  const out = { ...SETTING_DEFAULTS };
  try {
    const { results } = await env.DB.prepare('SELECT key, value FROM corr_settings').all();
    for (const r of results) out[r.key] = r.value;
  } catch { /* جدول هنوز ساخته نشده */ }
  return out;
}

function buildUpdate(table, obj, allowed, whereSql, whereBinds) {
  const cols = allowed.filter((c) => obj[c] !== undefined);
  if (!cols.length) return null;
  return {
    sql: `UPDATE ${table} SET ${cols.map((c) => c + '=?').join(',')} WHERE ${whereSql}`,
    binds: [...cols.map((c) => obj[c]), ...whereBinds],
  };
}

async function addEvent(env, requestId, e) {
  await env.DB.prepare(
    `INSERT INTO corr_events (request_id, actor, actor_name, kind, title, text, attachments_json, visible_company, visible_office)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).bind(
    requestId, e.actor, e.actor_name || '', e.kind || 'message', e.title || '', e.text || '',
    JSON.stringify(cleanUrls(e.attachments)), e.visible_company === 0 ? 0 : 1, e.visible_office ? 1 : 0
  ).run();
}

async function getActiveSubscription(env, companyId) {
  const now = nowSql();
  const sub = await env.DB.prepare(
    `SELECT * FROM corr_subscriptions WHERE company_id=? AND status='active' AND starts_at<=? AND ends_at>?
     ORDER BY ends_at DESC LIMIT 1`
  ).bind(companyId, now, now).first();
  if (!sub) return null;
  const hasQuota = sub.included_requests === 0 || sub.requests_used < sub.included_requests;
  return { ...sub, hasQuota };
}

// ===================================================================
export function registerCorrRoutes(router, { requireAdmin, requireCompany, notifyCompany, clientIp }) {
  const deny = () => error('دسترسی غیرمجاز', 401);

  async function requireOffice(request, env) {
    const payload = await verifyToken(getBearerToken(request), env.JWT_SECRET);
    if (!payload || payload.role !== 'office') return null;
    return payload;
  }
  const notify = async (env, companyId, title, body, code) => {
    try { await notifyCompany(env, companyId, { type: 'corr_status', title, body, link: 'corr.html?code=' + encodeURIComponent(code || '') }); } catch { /* اعلان نباید عملیات را خراب کند */ }
  };

  // ---------------------------------------------------------------
  // راه‌اندازی: ساخت جدول‌ها + داده نمونه (فقط مدیر، قابل اجرای مجدد)
  // ---------------------------------------------------------------
  router.post('/api/admin/corr/setup', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const log = [];
    for (const sql of CORR_SETUP_STATEMENTS) {
      try { await env.DB.prepare(sql).run(); log.push({ ok: true }); }
      catch (e) { log.push({ ok: false, error: String(e && e.message || e) }); }
    }
    try {
      for (const [k, v] of Object.entries(SETTING_DEFAULTS)) {
        await env.DB.prepare('INSERT OR IGNORE INTO corr_settings (key, value) VALUES (?,?)').bind(k, v).run();
      }
      const co = await env.DB.prepare('SELECT COUNT(*) c FROM corr_offices').first();
      if (!co.c) for (const [i, o] of SEED_OFFICES.entries()) {
        await env.DB.prepare('INSERT INTO corr_offices (name, level, county, sort_order) VALUES (?,?,?,?)').bind(o[0], o[1], o[2], i + 1).run();
      }
      const cs = await env.DB.prepare('SELECT COUNT(*) c FROM corr_services').first();
      if (!cs.c) for (const [i, s] of SEED_SERVICES.entries()) {
        await env.DB.prepare('INSERT INTO corr_services (title, description, price, sort_order) VALUES (?,?,?,?)').bind(s[0], s[1], s[2], i + 1).run();
      }
      const cp = await env.DB.prepare('SELECT COUNT(*) c FROM corr_plans').first();
      if (!cp.c) for (const [i, p] of SEED_PLANS.entries()) {
        await env.DB.prepare('INSERT INTO corr_plans (title, description, duration_days, price, included_requests, badge, active, sort_order) VALUES (?,?,?,?,?,?,0,?)')
          .bind(p[0], p[1], p[2], p[3], p[4], p[5], i + 1).run();
      }
    } catch (e) { log.push({ ok: false, error: 'seed: ' + String(e && e.message || e) }); }
    const failed = log.filter((l) => !l.ok);
    return json({ ok: failed.length === 0, total: log.length, failed });
  });

  // ---------------------------------------------------------------
  // عمومی: کاتالوگ (ادارات، خدمات، اشتراک‌ها) و رهگیری با کد
  // ---------------------------------------------------------------
  router.get('/api/corr/catalog', async ({ env }) => {
    try {
      const s = await getSettings(env);
      const { results: offices } = await env.DB.prepare('SELECT id, name, level, county FROM corr_offices WHERE active=1 ORDER BY level DESC, sort_order, id').all();
      const { results: services } = await env.DB.prepare('SELECT id, title, description, price FROM corr_services WHERE active=1 ORDER BY sort_order, id').all();
      const { results: plans } = await env.DB.prepare('SELECT id, title, description, duration_days, price, included_requests, badge FROM corr_plans WHERE active=1 ORDER BY sort_order, id').all();
      const done = await env.DB.prepare(`SELECT COUNT(*) c FROM corr_requests WHERE status='انجام شد'`).first();
      return json({
        ready: true,
        enabled: s.module_enabled === '1',
        intro: { title: s.intro_title, text: s.intro_text },
        allowWithoutSubscription: s.allow_without_subscription === '1',
        firstRequestFree: s.first_request_free === '1',
        offices, services, plans,
        stats: { offices: offices.length, done: done.c >= 10 ? done.c : null }, // آمار فقط وقتی معنادار باشد نشان داده می‌شود
      });
    } catch {
      return json({ ready: false, enabled: false });
    }
  });

  router.get('/api/corr/track/:code', async ({ env, params }) => {
    const code = str(params.code, 20).toUpperCase();
    const r = await env.DB.prepare(
      'SELECT id, tracking_code, status, office_name, referred_office_name, priority, created_at, updated_at FROM corr_requests WHERE tracking_code=?'
    ).bind(code).first();
    if (!r) return error('کدی با این مشخصات پیدا نشد', 404);
    const { results: events } = await env.DB.prepare(
      'SELECT kind, title, created_at FROM corr_events WHERE request_id=? AND visible_company=1 ORDER BY id'
    ).bind(r.id).all();
    delete r.id;
    return json({ ...r, events });
  });

  // ---------------------------------------------------------------
  // واحد (کاربر واردشده)
  // ---------------------------------------------------------------
  router.get('/api/company/corr/overview', async ({ request, env }) => {
    const auth = await requireCompany(request, env);
    if (!auth) return error('نیاز به ورود', 401);
    const cid = auth.companyId;
    const s = await getSettings(env);
    const sub = await getActiveSubscription(env, cid);
    const pending = await env.DB.prepare(`SELECT * FROM corr_subscriptions WHERE company_id=? AND status='pending' ORDER BY id DESC LIMIT 1`).bind(cid).first();
    const { results: requests } = await env.DB.prepare(
      `SELECT id, tracking_code, office_name, service_title, subject, status, priority, billing, fee, payment_status,
              referred_office_name, unread_company, created_at, updated_at
       FROM corr_requests WHERE company_id=? ORDER BY id DESC LIMIT 200`
    ).bind(cid).all();
    return json({
      subscription: sub, pendingSubscription: pending,
      payment: { card_number: s.card_number, card_owner: s.card_owner, bank_name: s.bank_name, note: s.payment_note },
      requests,
    });
  });

  router.post('/api/company/corr/requests', async ({ request, env }) => {
    const auth = await requireCompany(request, env);
    if (!auth) return error('برای ثبت درخواست ابتدا وارد شوید', 401);
    const cid = auth.companyId;
    const s = await getSettings(env);
    if (s.module_enabled !== '1') return error('این سرویس فعلاً غیرفعال است');
    const b = await readJson(request);
    const subject = str(b.subject, 200);
    const body = str(b.body, 5000);
    if (!subject) return error('موضوع درخواست الزامی است');
    const office = await env.DB.prepare('SELECT * FROM corr_offices WHERE id=? AND active=1').bind(toInt(b.office_id)).first();
    if (!office) return error('اداره موردنظر را انتخاب کنید');
    const service = await env.DB.prepare('SELECT * FROM corr_services WHERE id=? AND active=1').bind(toInt(b.service_id)).first();
    if (!service) return error('نوع خدمت را انتخاب کنید');
    const needsPhysical = b.needs_physical ? 1 : 0;
    const attachments = cleanUrls(b.attachments);
    if (!body && !attachments.length) return error('متن نامه را بنویسید یا تصویر/PDF آن را بارگذاری کنید');

    // محاسبهٔ نحوهٔ پرداخت
    let billing = 'pay_per_request', fee = service.price, paymentStatus = fee > 0 ? 'unpaid' : 'none', subId = null;
    const sub = await getActiveSubscription(env, cid);
    if (sub && sub.hasQuota) {
      billing = 'subscription'; fee = 0; paymentStatus = 'subscription'; subId = sub.id;
    } else {
      if (s.allow_without_subscription !== '1') return error('برای ثبت درخواست ابتدا اشتراک تهیه کنید (یا سهمیهٔ اشتراک شما تمام شده است)');
      if (s.first_request_free === '1') {
        const prev = await env.DB.prepare('SELECT COUNT(*) c FROM corr_requests WHERE company_id=?').bind(cid).first();
        if (!prev.c) { billing = 'free'; fee = 0; paymentStatus = 'free'; }
      }
    }

    // ساخت کد رهگیری یکتا
    let code = '', inserted = false, newId = null;
    for (let i = 0; i < 6 && !inserted; i++) {
      code = genTrackingCode();
      try {
        const res = await env.DB.prepare(
          `INSERT INTO corr_requests (tracking_code, company_id, office_id, office_name, service_id, service_title, subject, body,
             attachments_json, needs_physical, priority, billing, fee, payment_status, subscription_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(code, cid, office.id, office.name, service.id, service.title, subject, body, JSON.stringify(attachments),
          needsPhysical, PRIORITIES.includes(b.priority) ? b.priority : 'عادی', billing, fee, paymentStatus, subId).run();
        newId = res.meta.last_row_id; inserted = true;
      } catch (e) { if (!/UNIQUE/i.test(String(e && e.message))) throw e; }
    }
    if (!inserted) return error('ثبت درخواست ناموفق بود؛ دوباره تلاش کنید', 500);
    if (subId) await env.DB.prepare('UPDATE corr_subscriptions SET requests_used = requests_used + 1, updated_at=? WHERE id=?').bind(nowSql(), subId).run();

    const me = await env.DB.prepare('SELECT name FROM companies WHERE id=?').bind(cid).first();
    await addEvent(env, newId, { actor: 'company', actor_name: me?.name, kind: 'created', title: 'درخواست ثبت شد',
      text: needsPhysical ? 'نامهٔ فیزیکی (زنده) — تصویر/PDF پیوست شده است.' : '' });
    return json({
      id: newId, tracking_code: code, billing, fee, payment_status: paymentStatus,
      message: billing === 'subscription' ? 'درخواست ثبت شد و از سهمیهٔ اشتراک شما کسر شد.'
        : fee > 0 ? `درخواست ثبت شد. هزینهٔ این خدمت ${fa(fee)} تومان است؛ لطفاً پرداخت و رسید را ثبت کنید.`
        : 'درخواست ثبت شد؛ هزینه پس از بررسی توسط کارگزار اعلام می‌شود.',
    }, 201);
  });

  router.get('/api/company/corr/requests/:id', async ({ request, env, params }) => {
    const auth = await requireCompany(request, env);
    if (!auth) return error('نیاز به ورود', 401);
    const r = await env.DB.prepare('SELECT * FROM corr_requests WHERE id=? AND company_id=?').bind(toInt(params.id), auth.companyId).first();
    if (!r) return error('یافت نشد', 404);
    const { results: events } = await env.DB.prepare(
      'SELECT id, actor, actor_name, kind, title, text, attachments_json, created_at FROM corr_events WHERE request_id=? AND visible_company=1 ORDER BY id'
    ).bind(r.id).all();
    for (const e of events) { e.attachments = parseArr(e.attachments_json); delete e.attachments_json; }
    r.attachments = parseArr(r.attachments_json); delete r.attachments_json; delete r.admin_note; delete r.unread_admin;
    if (r.unread_company) await env.DB.prepare('UPDATE corr_requests SET unread_company=0 WHERE id=?').bind(r.id).run();
    return json({ ...r, events });
  });

  router.post('/api/company/corr/requests/:id/messages', async ({ request, env, params }) => {
    const auth = await requireCompany(request, env);
    if (!auth) return error('نیاز به ورود', 401);
    const r = await env.DB.prepare('SELECT * FROM corr_requests WHERE id=? AND company_id=?').bind(toInt(params.id), auth.companyId).first();
    if (!r) return error('یافت نشد', 404);
    if (r.status === 'لغو شد') return error('این درخواست لغو شده است');
    const b = await readJson(request);
    const text = str(b.text, 3000), att = cleanUrls(b.attachments);
    if (!text && !att.length) return error('متن یا پیوست لازم است');
    const me = await env.DB.prepare('SELECT name FROM companies WHERE id=?').bind(auth.companyId).first();
    await addEvent(env, r.id, { actor: 'company', actor_name: me?.name, kind: 'message', title: 'پیام واحد', text, attachments: att });
    await env.DB.prepare('UPDATE corr_requests SET unread_admin=1, updated_at=? WHERE id=?').bind(nowSql(), r.id).run();
    return json({ ok: true }, 201);
  });

  router.post('/api/company/corr/requests/:id/receipt', async ({ request, env, params }) => {
    const auth = await requireCompany(request, env);
    if (!auth) return error('نیاز به ورود', 401);
    const r = await env.DB.prepare('SELECT * FROM corr_requests WHERE id=? AND company_id=?').bind(toInt(params.id), auth.companyId).first();
    if (!r) return error('یافت نشد', 404);
    const b = await readJson(request);
    const url = cleanUrls([b.receipt_url])[0] || '', note = str(b.receipt_note, 500);
    if (!url && !note) return error('تصویر رسید یا شمارهٔ پیگیری پرداخت را وارد کنید');
    await env.DB.prepare(`UPDATE corr_requests SET receipt_url=?, receipt_note=?, payment_status='receipt_sent', unread_admin=1, updated_at=? WHERE id=?`)
      .bind(url, note, nowSql(), r.id).run();
    await addEvent(env, r.id, { actor: 'company', kind: 'payment', title: 'رسید پرداخت ثبت شد', text: note, attachments: url ? [url] : [] });
    return json({ ok: true });
  });

  router.post('/api/company/corr/requests/:id/cancel', async ({ request, env, params }) => {
    const auth = await requireCompany(request, env);
    if (!auth) return error('نیاز به ورود', 401);
    const r = await env.DB.prepare('SELECT * FROM corr_requests WHERE id=? AND company_id=?').bind(toInt(params.id), auth.companyId).first();
    if (!r) return error('یافت نشد', 404);
    if (r.status !== 'ثبت شد') return error('پس از شروع بررسی، لغو فقط از طریق پشتیبانی ممکن است');
    await env.DB.prepare(`UPDATE corr_requests SET status='لغو شد', updated_at=? WHERE id=?`).bind(nowSql(), r.id).run();
    if (r.billing === 'subscription' && r.subscription_id) {
      await env.DB.prepare('UPDATE corr_subscriptions SET requests_used = MAX(requests_used - 1, 0) WHERE id=?').bind(r.subscription_id).run();
    }
    await addEvent(env, r.id, { actor: 'company', kind: 'status', title: 'درخواست توسط واحد لغو شد' });
    return json({ ok: true });
  });

  router.post('/api/company/corr/subscribe', async ({ request, env }) => {
    const auth = await requireCompany(request, env);
    if (!auth) return error('نیاز به ورود', 401);
    const b = await readJson(request);
    const plan = await env.DB.prepare('SELECT * FROM corr_plans WHERE id=? AND active=1').bind(toInt(b.plan_id)).first();
    if (!plan) return error('طرح اشتراک نامعتبر است');
    const pending = await env.DB.prepare(`SELECT id FROM corr_subscriptions WHERE company_id=? AND status='pending'`).bind(auth.companyId).first();
    if (pending) return error('یک درخواست اشتراک در انتظار تأیید دارید؛ منتظر بررسی بمانید');
    const url = cleanUrls([b.receipt_url])[0] || '', note = str(b.receipt_note, 500);
    if (!url && !note) return error('تصویر رسید یا شمارهٔ پیگیری پرداخت را وارد کنید');
    await env.DB.prepare(
      `INSERT INTO corr_subscriptions (company_id, plan_id, plan_title, amount, included_requests, status, receipt_url, receipt_note)
       VALUES (?,?,?,?,?,'pending',?,?)`
    ).bind(auth.companyId, plan.id, plan.title, plan.price, plan.included_requests, url, note).run();
    return json({ ok: true, message: 'درخواست اشتراک ثبت شد؛ پس از بررسی رسید فعال می‌شود.' }, 201);
  });

  // ---------------------------------------------------------------
  // پنل مدیریت: آمار، فهرست و مدیریت درخواست‌ها
  // ---------------------------------------------------------------
  router.get('/api/admin/corr/badge', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    try {
      const a = await env.DB.prepare(`SELECT COUNT(*) c FROM corr_requests WHERE unread_admin=1 AND status NOT IN ('انجام شد','لغو شد')`).first();
      const b = await env.DB.prepare(`SELECT COUNT(*) c FROM corr_subscriptions WHERE status='pending'`).first();
      return json({ requests: a.c, subscriptions: b.c, total: a.c + b.c });
    } catch { return json({ requests: 0, subscriptions: 0, total: 0, notReady: true }); }
  });

  router.get('/api/admin/corr/stats', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const { results: byStatus } = await env.DB.prepare('SELECT status, COUNT(*) c FROM corr_requests GROUP BY status').all();
    const { results: byOffice } = await env.DB.prepare(
      `SELECT COALESCE(referred_office_id, office_id) office_id, COALESCE(referred_office_name, office_name) office_name, COUNT(*) c,
              SUM(CASE WHEN status NOT IN ('انجام شد','لغو شد') THEN 1 ELSE 0 END) open_count
       FROM corr_requests GROUP BY COALESCE(referred_office_id, office_id), COALESCE(referred_office_name, office_name) ORDER BY open_count DESC, c DESC`
    ).all();
    const pay = await env.DB.prepare(`SELECT SUM(CASE WHEN payment_status='receipt_sent' THEN 1 ELSE 0 END) receipts,
        SUM(CASE WHEN payment_status='unpaid' THEN 1 ELSE 0 END) unpaid FROM corr_requests`).first();
    const subs = await env.DB.prepare(`SELECT SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending,
        SUM(CASE WHEN status='active' AND ends_at>? THEN 1 ELSE 0 END) active FROM corr_subscriptions`).bind(nowSql()).first();
    return json({ byStatus, byOffice, payments: { receipts: pay.receipts || 0, unpaid: pay.unpaid || 0 }, subscriptions: { pending: subs.pending || 0, active: subs.active || 0 } });
  });

  router.get('/api/admin/corr/requests', async ({ request, env, url }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const q = url.searchParams;
    const where = [], binds = [];
    if (q.get('status')) { where.push('r.status=?'); binds.push(q.get('status')); }
    if (q.get('office_id')) { where.push('(r.office_id=? OR r.referred_office_id=?)'); binds.push(toInt(q.get('office_id')), toInt(q.get('office_id'))); }
    if (q.get('payment')) { where.push('r.payment_status=?'); binds.push(q.get('payment')); }
    if (q.get('unread') === '1') where.push('r.unread_admin=1');
    if (q.get('open') === '1') where.push(`r.status NOT IN ('انجام شد','لغو شد')`);
    if (q.get('q')) {
      where.push('(r.tracking_code LIKE ? OR r.subject LIKE ? OR c.name LIKE ?)');
      const like = '%' + q.get('q').trim() + '%'; binds.push(like, like, like);
    }
    const sql = `SELECT r.id, r.tracking_code, r.company_id, c.name company_name, c.phone company_phone, r.office_name, r.referred_office_id,
        r.referred_office_name, r.service_title, r.subject, r.status, r.priority, r.billing, r.fee, r.payment_status,
        r.needs_physical, r.unread_admin, r.created_at, r.updated_at
      FROM corr_requests r LEFT JOIN companies c ON c.id=r.company_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY (r.priority='فوری') DESC, r.unread_admin DESC, r.updated_at DESC LIMIT 300`;
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json(results);
  });

  router.get('/api/admin/corr/requests/:id', async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const r = await env.DB.prepare(
      `SELECT r.*, c.name company_name, c.phone company_phone, c.county company_county
       FROM corr_requests r LEFT JOIN companies c ON c.id=r.company_id WHERE r.id=?`
    ).bind(toInt(params.id)).first();
    if (!r) return error('یافت نشد', 404);
    const { results: events } = await env.DB.prepare('SELECT * FROM corr_events WHERE request_id=? ORDER BY id').bind(r.id).all();
    for (const e of events) { e.attachments = parseArr(e.attachments_json); delete e.attachments_json; }
    r.attachments = parseArr(r.attachments_json); delete r.attachments_json;
    if (r.unread_admin) await env.DB.prepare('UPDATE corr_requests SET unread_admin=0 WHERE id=?').bind(r.id).run();
    return json({ ...r, events });
  });

  router.put('/api/admin/corr/requests/:id', async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const id = toInt(params.id);
    const r = await env.DB.prepare('SELECT * FROM corr_requests WHERE id=?').bind(id).first();
    if (!r) return error('یافت نشد', 404);
    const b = await readJson(request);
    const upd = {};
    let notifyText = null, visibleChange = false;

    if (b.priority !== undefined && PRIORITIES.includes(b.priority)) upd.priority = b.priority;
    if (b.admin_note !== undefined) upd.admin_note = str(b.admin_note, 2000);

    // ارجاع به اداره
    if (b.referred_office_id !== undefined) {
      const refId = b.referred_office_id ? toInt(b.referred_office_id) : null;
      if (refId !== r.referred_office_id) {
        if (refId) {
          const off = await env.DB.prepare('SELECT * FROM corr_offices WHERE id=?').bind(refId).first();
          if (!off) return error('اداره موردنظر یافت نشد');
          upd.referred_office_id = refId; upd.referred_office_name = off.name;
          if (b.status === undefined && ['ثبت شد', 'در حال بررسی'].includes(r.status)) upd.status = 'ارجاع شد';
          await addEvent(env, id, { actor: 'admin', actor_name: 'همتا صنعت', kind: 'referral', title: `ارجاع به: ${off.name}`,
            text: str(b.referral_note, 1000), visible_company: 1, visible_office: 1 });
          visibleChange = true; notifyText = `درخواست شما به «${off.name}» ارجاع شد.`;
        } else {
          upd.referred_office_id = null; upd.referred_office_name = null;
          await addEvent(env, id, { actor: 'admin', actor_name: 'همتا صنعت', kind: 'referral', title: 'ارجاع لغو شد', visible_company: 0, visible_office: 1 });
        }
      }
    }

    // وضعیت
    if (b.status !== undefined && b.status !== r.status) {
      if (!CORR_STATUSES.includes(b.status)) return error('وضعیت نامعتبر است');
      upd.status = b.status;
      await addEvent(env, id, { actor: 'admin', actor_name: 'همتا صنعت', kind: 'status', title: `وضعیت: ${b.status}`, text: str(b.status_note, 1000) });
      visibleChange = true; notifyText = `وضعیت درخواست شما: ${b.status}`;
      if (b.status === 'لغو شد' && r.billing === 'subscription' && r.subscription_id) {
        await env.DB.prepare('UPDATE corr_subscriptions SET requests_used = MAX(requests_used - 1, 0) WHERE id=?').bind(r.subscription_id).run();
      }
    } else if (upd.status === undefined && b.status !== undefined) { /* بدون تغییر */ }

    // مبلغ و پرداخت
    if (b.fee !== undefined && toInt(b.fee) !== r.fee) {
      upd.fee = Math.max(toInt(b.fee), 0);
      if (upd.fee > 0 && ['none', 'free'].includes(r.payment_status) && b.payment_status === undefined) upd.payment_status = 'unpaid';
      await addEvent(env, id, { actor: 'admin', actor_name: 'همتا صنعت', kind: 'payment', title: upd.fee > 0 ? `هزینهٔ این خدمت: ${fa(upd.fee)} تومان` : 'هزینهٔ این خدمت: رایگان' });
      visibleChange = true; notifyText = notifyText || (upd.fee > 0 ? `هزینهٔ درخواست شما ${fa(upd.fee)} تومان اعلام شد.` : null);
    }
    if (b.payment_status !== undefined && b.payment_status !== r.payment_status) {
      if (!PAYMENT_STATUSES.includes(b.payment_status)) return error('وضعیت پرداخت نامعتبر است');
      upd.payment_status = b.payment_status;
      const label = { paid: 'پرداخت تأیید شد', unpaid: 'در انتظار پرداخت', receipt_sent: 'رسید در حال بررسی', none: 'بدون هزینه', free: 'رایگان', subscription: 'از محل اشتراک' }[b.payment_status];
      await addEvent(env, id, { actor: 'admin', actor_name: 'همتا صنعت', kind: 'payment', title: label });
      visibleChange = true; if (b.payment_status === 'paid') notifyText = notifyText || 'پرداخت شما تأیید شد. سپاس!';
    }

    const u = buildUpdate('corr_requests', { ...upd, updated_at: nowSql(), ...(visibleChange ? { unread_company: 1 } : {}) },
      ['priority', 'admin_note', 'referred_office_id', 'referred_office_name', 'status', 'fee', 'payment_status', 'updated_at', 'unread_company'], 'id=?', [id]);
    if (u) await env.DB.prepare(u.sql).bind(...u.binds).run();
    if (notifyText) await notify(env, r.company_id, `درخواست ${r.tracking_code}`, notifyText, r.tracking_code);
    return json({ ok: true });
  });

  router.post('/api/admin/corr/requests/:id/messages', async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const id = toInt(params.id);
    const r = await env.DB.prepare('SELECT * FROM corr_requests WHERE id=?').bind(id).first();
    if (!r) return error('یافت نشد', 404);
    const b = await readJson(request);
    const text = str(b.text, 3000), att = cleanUrls(b.attachments);
    if (!text && !att.length) return error('متن یا پیوست لازم است');
    const toCompany = b.visible_company !== false && b.visible_company !== 0;
    const toOffice = !!b.visible_office;
    await addEvent(env, id, { actor: 'admin', actor_name: 'همتا صنعت', kind: 'message', title: toOffice && !toCompany ? 'دستور/توضیح برای اداره' : 'پیام همتا صنعت',
      text, attachments: att, visible_company: toCompany ? 1 : 0, visible_office: toOffice ? 1 : 0 });
    await env.DB.prepare('UPDATE corr_requests SET updated_at=?, unread_company=? WHERE id=?').bind(nowSql(), toCompany ? 1 : r.unread_company, id).run();
    if (toCompany) await notify(env, r.company_id, `پیام دربارهٔ درخواست ${r.tracking_code}`, text.slice(0, 120), r.tracking_code);
    return json({ ok: true }, 201);
  });

  // انتشار/پنهان‌کردن یک رویداد برای واحد یا اداره (مثلاً انتشار پاسخ اداره برای واحد)
  router.put('/api/admin/corr/events/:id', async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const ev = await env.DB.prepare('SELECT * FROM corr_events WHERE id=?').bind(toInt(params.id)).first();
    if (!ev) return error('یافت نشد', 404);
    const b = await readJson(request);
    const vc = b.visible_company === undefined ? ev.visible_company : (b.visible_company ? 1 : 0);
    const vo = b.visible_office === undefined ? ev.visible_office : (b.visible_office ? 1 : 0);
    await env.DB.prepare('UPDATE corr_events SET visible_company=?, visible_office=? WHERE id=?').bind(vc, vo, ev.id).run();
    if (vc && !ev.visible_company) {
      const r = await env.DB.prepare('SELECT * FROM corr_requests WHERE id=?').bind(ev.request_id).first();
      if (r) {
        await env.DB.prepare('UPDATE corr_requests SET unread_company=1, updated_at=? WHERE id=?').bind(nowSql(), r.id).run();
        await notify(env, r.company_id, `پاسخ جدید برای درخواست ${r.tracking_code}`, 'پاسخ اداره در پیگیری شما ثبت شد.', r.tracking_code);
      }
    }
    return json({ ok: true });
  });

  // ---------------------------------------------------------------
  // پنل مدیریت: ادارات، کاربران ادارات، خدمات، طرح‌ها، تنظیمات، اشتراک‌ها
  // ---------------------------------------------------------------
  router.get('/api/admin/corr/offices', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const { results } = await env.DB.prepare(
      `SELECT o.*, (SELECT COUNT(*) FROM corr_requests r WHERE r.office_id=o.id OR r.referred_office_id=o.id) requests_count,
              (SELECT COUNT(*) FROM corr_office_users u WHERE u.office_id=o.id) users_count
       FROM corr_offices o ORDER BY o.level DESC, o.sort_order, o.id`).all();
    return json(results);
  });
  router.post('/api/admin/corr/offices', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const b = await readJson(request);
    const name = str(b.name, 200);
    if (!name) return error('نام اداره الزامی است');
    const res = await env.DB.prepare('INSERT INTO corr_offices (name, level, county, description, active, sort_order) VALUES (?,?,?,?,?,?)')
      .bind(name, OFFICE_LEVELS.includes(b.level) ? b.level : 'شهرستان', str(b.county, 60), str(b.description, 500), b.active === 0 ? 0 : 1, toInt(b.sort_order)).run();
    return json({ id: res.meta.last_row_id }, 201);
  });
  router.put('/api/admin/corr/offices/:id', async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const b = await readJson(request);
    const patch = {};
    if (b.name !== undefined) patch.name = str(b.name, 200);
    if (b.level !== undefined && OFFICE_LEVELS.includes(b.level)) patch.level = b.level;
    if (b.county !== undefined) patch.county = str(b.county, 60);
    if (b.description !== undefined) patch.description = str(b.description, 500);
    if (b.active !== undefined) patch.active = b.active ? 1 : 0;
    if (b.sort_order !== undefined) patch.sort_order = toInt(b.sort_order);
    if (patch.name === '') return error('نام اداره نمی‌تواند خالی باشد');
    const u = buildUpdate('corr_offices', patch, Object.keys(patch), 'id=?', [toInt(params.id)]);
    if (!u) return error('چیزی برای تغییر ارسال نشده');
    await env.DB.prepare(u.sql).bind(...u.binds).run();
    return json({ ok: true });
  });
  router.del('/api/admin/corr/offices/:id', async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const id = toInt(params.id);
    const used = await env.DB.prepare('SELECT COUNT(*) c FROM corr_requests WHERE office_id=? OR referred_office_id=?').bind(id, id).first();
    if (used.c > 0) {
      await env.DB.prepare('UPDATE corr_offices SET active=0 WHERE id=?').bind(id).run();
      return json({ ok: true, deactivated: true, message: 'این اداره در درخواست‌ها استفاده شده بود؛ به‌جای حذف، غیرفعال شد.' });
    }
    await env.DB.prepare('DELETE FROM corr_office_users WHERE office_id=?').bind(id).run();
    await env.DB.prepare('DELETE FROM corr_offices WHERE id=?').bind(id).run();
    return json({ ok: true });
  });

  router.get('/api/admin/corr/office-users', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.office_id, o.name office_name, u.username, u.full_name, u.active, u.last_login_at, u.created_at
       FROM corr_office_users u LEFT JOIN corr_offices o ON o.id=u.office_id ORDER BY u.id DESC`).all();
    return json(results);
  });
  router.post('/api/admin/corr/office-users', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const b = await readJson(request);
    const username = str(b.username, 40).toLowerCase();
    if (!/^[a-z0-9_.-]{3,40}$/.test(username)) return error('نام کاربری باید ۳ تا ۴۰ حرف انگلیسی/عدد باشد');
    if (str(b.password, 100).length < 6) return error('رمز عبور حداقل ۶ کاراکتر باشد');
    const office = await env.DB.prepare('SELECT id FROM corr_offices WHERE id=?').bind(toInt(b.office_id)).first();
    if (!office) return error('اداره را انتخاب کنید');
    const exists = await env.DB.prepare('SELECT id FROM corr_office_users WHERE username=?').bind(username).first();
    if (exists) return error('این نام کاربری قبلاً استفاده شده', 409);
    const res = await env.DB.prepare('INSERT INTO corr_office_users (office_id, username, password_hash, full_name) VALUES (?,?,?,?)')
      .bind(office.id, username, await hashPassword(String(b.password)), str(b.full_name, 100)).run();
    return json({ id: res.meta.last_row_id }, 201);
  });
  router.put('/api/admin/corr/office-users/:id', async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const b = await readJson(request);
    const patch = {};
    if (b.password) { if (String(b.password).length < 6) return error('رمز عبور حداقل ۶ کاراکتر باشد'); patch.password_hash = await hashPassword(String(b.password)); }
    if (b.full_name !== undefined) patch.full_name = str(b.full_name, 100);
    if (b.active !== undefined) patch.active = b.active ? 1 : 0;
    if (b.office_id !== undefined) patch.office_id = toInt(b.office_id);
    const u = buildUpdate('corr_office_users', patch, Object.keys(patch), 'id=?', [toInt(params.id)]);
    if (!u) return error('چیزی برای تغییر ارسال نشده');
    await env.DB.prepare(u.sql).bind(...u.binds).run();
    return json({ ok: true });
  });
  router.del('/api/admin/corr/office-users/:id', async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return deny();
    await env.DB.prepare('DELETE FROM corr_office_users WHERE id=?').bind(toInt(params.id)).run();
    return json({ ok: true });
  });

  // خدمات و نرخ‌ها
  router.get('/api/admin/corr/services', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const { results } = await env.DB.prepare('SELECT * FROM corr_services ORDER BY sort_order, id').all();
    return json(results);
  });
  router.post('/api/admin/corr/services', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const b = await readJson(request);
    if (!str(b.title)) return error('عنوان خدمت الزامی است');
    const res = await env.DB.prepare('INSERT INTO corr_services (title, description, price, active, sort_order) VALUES (?,?,?,?,?)')
      .bind(str(b.title, 200), str(b.description, 500), Math.max(toInt(b.price), 0), b.active === 0 ? 0 : 1, toInt(b.sort_order)).run();
    return json({ id: res.meta.last_row_id }, 201);
  });
  router.put('/api/admin/corr/services/:id', async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const b = await readJson(request);
    const patch = {};
    if (b.title !== undefined) patch.title = str(b.title, 200);
    if (b.description !== undefined) patch.description = str(b.description, 500);
    if (b.price !== undefined) patch.price = Math.max(toInt(b.price), 0);
    if (b.active !== undefined) patch.active = b.active ? 1 : 0;
    if (b.sort_order !== undefined) patch.sort_order = toInt(b.sort_order);
    if (patch.title === '') return error('عنوان نمی‌تواند خالی باشد');
    const u = buildUpdate('corr_services', patch, Object.keys(patch), 'id=?', [toInt(params.id)]);
    if (!u) return error('چیزی برای تغییر ارسال نشده');
    await env.DB.prepare(u.sql).bind(...u.binds).run();
    return json({ ok: true });
  });
  router.del('/api/admin/corr/services/:id', async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return deny();
    await env.DB.prepare('DELETE FROM corr_services WHERE id=?').bind(toInt(params.id)).run(); // عنوان در درخواست‌ها کپی شده؛ تاریخچه آسیب نمی‌بیند
    return json({ ok: true });
  });

  // طرح‌های اشتراک
  router.get('/api/admin/corr/plans', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const { results } = await env.DB.prepare('SELECT * FROM corr_plans ORDER BY sort_order, id').all();
    return json(results);
  });
  router.post('/api/admin/corr/plans', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const b = await readJson(request);
    if (!str(b.title)) return error('عنوان طرح الزامی است');
    const res = await env.DB.prepare('INSERT INTO corr_plans (title, description, duration_days, price, included_requests, badge, active, sort_order) VALUES (?,?,?,?,?,?,?,?)')
      .bind(str(b.title, 200), str(b.description, 500), Math.max(toInt(b.duration_days, 30), 1), Math.max(toInt(b.price), 0),
        Math.max(toInt(b.included_requests), 0), str(b.badge, 40), b.active === 0 ? 0 : 1, toInt(b.sort_order)).run();
    return json({ id: res.meta.last_row_id }, 201);
  });
  router.put('/api/admin/corr/plans/:id', async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const b = await readJson(request);
    const patch = {};
    if (b.title !== undefined) patch.title = str(b.title, 200);
    if (b.description !== undefined) patch.description = str(b.description, 500);
    if (b.duration_days !== undefined) patch.duration_days = Math.max(toInt(b.duration_days, 30), 1);
    if (b.price !== undefined) patch.price = Math.max(toInt(b.price), 0);
    if (b.included_requests !== undefined) patch.included_requests = Math.max(toInt(b.included_requests), 0);
    if (b.badge !== undefined) patch.badge = str(b.badge, 40);
    if (b.active !== undefined) patch.active = b.active ? 1 : 0;
    if (b.sort_order !== undefined) patch.sort_order = toInt(b.sort_order);
    if (patch.title === '') return error('عنوان نمی‌تواند خالی باشد');
    const u = buildUpdate('corr_plans', patch, Object.keys(patch), 'id=?', [toInt(params.id)]);
    if (!u) return error('چیزی برای تغییر ارسال نشده');
    await env.DB.prepare(u.sql).bind(...u.binds).run();
    return json({ ok: true });
  });
  router.del('/api/admin/corr/plans/:id', async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return deny();
    await env.DB.prepare('DELETE FROM corr_plans WHERE id=?').bind(toInt(params.id)).run(); // اشتراک‌های فعال با عنوان کپی‌شده می‌مانند
    return json({ ok: true });
  });

  // تنظیمات (کارت بانکی، متن‌ها، قوانین)
  router.get('/api/admin/corr/settings', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    return json(await getSettings(env));
  });
  router.put('/api/admin/corr/settings', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const b = await readJson(request);
    for (const k of Object.keys(SETTING_DEFAULTS)) {
      if (b[k] === undefined) continue;
      await env.DB.prepare('INSERT INTO corr_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .bind(k, str(b[k], 1000)).run();
    }
    return json({ ok: true });
  });

  // اشتراک‌ها
  router.get('/api/admin/corr/subscriptions', async ({ request, env, url }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const status = url.searchParams.get('status');
    const { results } = await env.DB.prepare(
      `SELECT s.*, c.name company_name, c.phone company_phone FROM corr_subscriptions s LEFT JOIN companies c ON c.id=s.company_id
       ${status ? 'WHERE s.status=?' : ''} ORDER BY (s.status='pending') DESC, s.id DESC LIMIT 300`
    ).bind(...(status ? [status] : [])).all();
    return json(results);
  });
  router.put('/api/admin/corr/subscriptions/:id', async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const sub = await env.DB.prepare('SELECT * FROM corr_subscriptions WHERE id=?').bind(toInt(params.id)).first();
    if (!sub) return error('یافت نشد', 404);
    const b = await readJson(request);
    const plan = sub.plan_id ? await env.DB.prepare('SELECT * FROM corr_plans WHERE id=?').bind(sub.plan_id).first() : null;
    if (b.action === 'approve') {
      const days = toInt(b.duration_days) || (plan ? plan.duration_days : 30);
      const now = nowSql();
      const current = await env.DB.prepare(`SELECT MAX(ends_at) e FROM corr_subscriptions WHERE company_id=? AND status='active' AND ends_at>?`).bind(sub.company_id, now).first();
      const start = current && current.e ? current.e : now; // اگر اشتراک فعال دارد، بعد از پایان آن شروع می‌شود
      await env.DB.prepare(`UPDATE corr_subscriptions SET status='active', starts_at=?, ends_at=?, admin_note=?, updated_at=? WHERE id=?`)
        .bind(start, addDaysSql(start, days), str(b.admin_note, 500), now, sub.id).run();
      await notify(env, sub.company_id, 'اشتراک دستیار اداری فعال شد', `${sub.plan_title || 'اشتراک'} برای شما فعال شد. از همین حالا درخواست ثبت کنید.`, '');
    } else if (b.action === 'reject') {
      await env.DB.prepare(`UPDATE corr_subscriptions SET status='rejected', admin_note=?, updated_at=? WHERE id=?`).bind(str(b.admin_note, 500), nowSql(), sub.id).run();
      await notify(env, sub.company_id, 'درخواست اشتراک تأیید نشد', str(b.admin_note, 150) || 'لطفاً رسید پرداخت را بررسی و دوباره ثبت کنید.', '');
    } else if (b.action === 'expire') {
      await env.DB.prepare(`UPDATE corr_subscriptions SET status='expired', updated_at=? WHERE id=?`).bind(nowSql(), sub.id).run();
    } else return error('عملیات نامعتبر است');
    return json({ ok: true });
  });
  // اعطای دستی اشتراک (هدیه/توافق خارج از سیستم)
  router.post('/api/admin/corr/subscriptions', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const b = await readJson(request);
    const company = await env.DB.prepare('SELECT id, name FROM companies WHERE id=?').bind(toInt(b.company_id)).first();
    if (!company) return error('واحد یافت نشد');
    const plan = await env.DB.prepare('SELECT * FROM corr_plans WHERE id=?').bind(toInt(b.plan_id)).first();
    if (!plan) return error('طرح یافت نشد');
    const now = nowSql();
    await env.DB.prepare(
      `INSERT INTO corr_subscriptions (company_id, plan_id, plan_title, amount, included_requests, status, starts_at, ends_at, admin_note)
       VALUES (?,?,?,?,?,'active',?,?,?)`
    ).bind(company.id, plan.id, plan.title, toInt(b.amount), plan.included_requests, now, addDaysSql(now, toInt(b.duration_days) || plan.duration_days), str(b.admin_note, 500) || 'اعطای دستی').run();
    await notify(env, company.id, 'اشتراک دستیار اداری فعال شد', `${plan.title} برای شما فعال شد.`, '');
    return json({ ok: true }, 201);
  });
  // جستجوی سریع واحد برای اعطای اشتراک
  router.get('/api/admin/corr/company-search', async ({ request, env, url }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const q = '%' + str(url.searchParams.get('q'), 60) + '%';
    const { results } = await env.DB.prepare('SELECT id, name, phone FROM companies WHERE name LIKE ? OR phone LIKE ? ORDER BY id DESC LIMIT 15').bind(q, q).all();
    return json(results);
  });

  // ---------------------------------------------------------------
  // پشتیبان‌گیری / بازیابی / پاک‌کردن داده‌های آزمایشی (فقط جدول‌های همین ماژول)
  // ---------------------------------------------------------------
  const CORR_TABLES = ['corr_settings', 'corr_offices', 'corr_office_users', 'corr_services', 'corr_plans', 'corr_subscriptions', 'corr_requests', 'corr_events'];
  router.get('/api/admin/corr/backup', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const dump = { corr: true, created_at: new Date().toISOString(), tables: {} };
    for (const t of CORR_TABLES) { const { results } = await env.DB.prepare(`SELECT * FROM ${t}`).all(); dump.tables[t] = results; }
    return json(dump);
  });
  router.post('/api/admin/corr/restore', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const b = await readJson(request);
    if (!b.corr || !b.tables) return error('این فایل، پشتیبان «امور اداری» نیست');
    for (const t of CORR_TABLES) { // پیش از هر تغییر، ساختار همهٔ ردیف‌ها بررسی می‌شود
      for (const row of (Array.isArray(b.tables[t]) ? b.tables[t] : [])) {
        if (!Object.keys(row).every((c) => /^[a-z_]+$/.test(c))) return error('فایل پشتیبان نامعتبر است');
      }
    }
    for (const t of [...CORR_TABLES].reverse()) if (Array.isArray(b.tables[t])) await env.DB.prepare(`DELETE FROM ${t}`).run();
    for (const t of CORR_TABLES) {
      for (const row of (Array.isArray(b.tables[t]) ? b.tables[t] : [])) {
        const cols = Object.keys(row);
        await env.DB.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map((c) => row[c] ?? null)).run();
      }
    }
    return json({ ok: true, message: 'بازیابی امور اداری انجام شد.' });
  });
  // حذف درخواست‌ها/اشتراک‌های آزمایشی (ادارات، خدمات، طرح‌ها و تنظیمات می‌مانند)
  router.post('/api/admin/corr/wipe-requests', async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return deny();
    const b = await readJson(request);
    if (b.confirm !== 'پاک کن') return error('برای تأیید، عبارت درخواست‌شده را دقیق ارسال کنید');
    for (const t of ['corr_events', 'corr_requests', 'corr_subscriptions']) await env.DB.prepare(`DELETE FROM ${t}`).run();
    return json({ ok: true, message: 'همهٔ درخواست‌ها و اشتراک‌های آزمایشی پاک شد.' });
  });

  // ---------------------------------------------------------------
  // پورتال ادارات (ورود با نام کاربری/رمز؛ فقط نامه‌های ارجاع‌شده)
  // ---------------------------------------------------------------
  router.post('/api/office/login', async ({ request, env }) => {
    const b = await readJson(request);
    const username = str(b.username, 40).toLowerCase();
    const ip = clientIp(request);
    if (await tooManyAttempts(env.DB, 'office', username, ip)) return error('تعداد تلاش بیش از حد مجاز؛ کمی بعد دوباره تلاش کنید', 429);
    const u = await env.DB.prepare(
      `SELECT u.*, o.name office_name, o.active office_active FROM corr_office_users u LEFT JOIN corr_offices o ON o.id=u.office_id WHERE u.username=?`
    ).bind(username).first();
    const ok = u && u.active && u.office_active && await verifyPassword(String(b.password || ''), u.password_hash);
    await recordAttempt(env.DB, 'office', username, ip, !!ok);
    if (!ok) return error('نام کاربری یا رمز عبور اشتباه است', 401);
    await env.DB.prepare('UPDATE corr_office_users SET last_login_at=? WHERE id=?').bind(nowSql(), u.id).run();
    const token = await signToken({ role: 'office', userId: u.id, officeId: u.office_id }, env.JWT_SECRET, 60 * 60 * 24);
    return json({ token, office: { id: u.office_id, name: u.office_name }, user: { name: u.full_name || u.username } });
  });

  router.get('/api/office/requests', async ({ request, env }) => {
    const auth = await requireOffice(request, env);
    if (!auth) return error('نیاز به ورود', 401);
    const { results } = await env.DB.prepare(
      `SELECT r.id, r.tracking_code, c.name company_name, r.subject, r.status, r.priority, r.created_at, r.updated_at
       FROM corr_requests r LEFT JOIN companies c ON c.id=r.company_id
       WHERE r.referred_office_id=? AND r.status!='لغو شد' ORDER BY (r.status IN ('ارجاع شد','پاسخ ارسال شد')) DESC, r.updated_at DESC LIMIT 300`
    ).bind(auth.officeId).all();
    return json(results);
  });

  router.get('/api/office/requests/:id', async ({ request, env, params }) => {
    const auth = await requireOffice(request, env);
    if (!auth) return error('نیاز به ورود', 401);
    const r = await env.DB.prepare(
      `SELECT r.id, r.tracking_code, c.name company_name, r.subject, r.body, r.attachments_json, r.needs_physical, r.status, r.priority, r.created_at, r.updated_at
       FROM corr_requests r LEFT JOIN companies c ON c.id=r.company_id WHERE r.id=? AND r.referred_office_id=?`
    ).bind(toInt(params.id), auth.officeId).first();
    if (!r) return error('یافت نشد', 404);
    const { results: events } = await env.DB.prepare(
      'SELECT id, actor, actor_name, kind, title, text, attachments_json, created_at FROM corr_events WHERE request_id=? AND visible_office=1 ORDER BY id'
    ).bind(r.id).all();
    for (const e of events) { e.attachments = parseArr(e.attachments_json); delete e.attachments_json; }
    r.attachments = parseArr(r.attachments_json); delete r.attachments_json;
    return json({ ...r, events });
  });

  router.post('/api/office/requests/:id/reply', async ({ request, env, params }) => {
    const auth = await requireOffice(request, env);
    if (!auth) return error('نیاز به ورود', 401);
    const r = await env.DB.prepare('SELECT * FROM corr_requests WHERE id=? AND referred_office_id=?').bind(toInt(params.id), auth.officeId).first();
    if (!r) return error('یافت نشد', 404);
    const b = await readJson(request);
    const isAck = b.kind === 'ack';
    const text = str(b.text, 3000) || (isAck ? 'نامه دریافت شد.' : ''), att = cleanUrls(b.attachments);
    if (!text && !att.length) return error('متن یا پیوست لازم است');
    const u = await env.DB.prepare('SELECT full_name, username FROM corr_office_users WHERE id=?').bind(auth.userId).first();
    const office = await env.DB.prepare('SELECT name FROM corr_offices WHERE id=?').bind(auth.officeId).first();
    await addEvent(env, r.id, {
      actor: 'office', actor_name: `${office?.name || 'اداره'}${u ? ' — ' + (u.full_name || u.username) : ''}`,
      kind: isAck ? 'office_ack' : 'office_reply', title: isAck ? 'اداره دریافت نامه را اعلام کرد' : 'پاسخ اداره',
      text, attachments: att, visible_company: 0, visible_office: 1, // پیش‌فرض: فقط مدیر می‌بیند تا بررسی و منتشر کند
    });
    const newStatus = (!isAck && !['انجام شد', 'لغو شد'].includes(r.status)) ? 'پاسخ اداره دریافت شد' : r.status;
    await env.DB.prepare('UPDATE corr_requests SET status=?, unread_admin=1, updated_at=? WHERE id=?').bind(newStatus, nowSql(), r.id).run();
    return json({ ok: true }, 201);
  });
}
