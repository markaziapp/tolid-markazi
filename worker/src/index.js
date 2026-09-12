import { Router } from './router.js';
import { json, error, readJson, randomKey, pick } from './utils.js';
import { hashPassword, verifyPassword, signToken, verifyToken, getBearerToken, tooManyAttempts, recordAttempt } from './auth.js';
import { uploadToGithub } from './githubStorage.js';

const router = new Router();

// ------------------------------------------------------------------
// میان‌افزارهای احراز هویت
// ------------------------------------------------------------------
async function requireAdmin(request, env) {
  const token = getBearerToken(request);
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload || payload.role !== 'admin') return null;
  return payload;
}
async function requireCompany(request, env) {
  const token = getBearerToken(request);
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload || payload.role !== 'company') return null;
  return payload;
}
function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || '';
}
function computeBadges(c, responseTimes) {
  const badges = [];
  try {
    const created = new Date((c.created_at || '').replace(' ', 'T') + 'Z');
    const years = Math.floor((Date.now() - created.getTime()) / (365 * 24 * 3600 * 1000));
    if (years >= 1) badges.push(`${years} سال فعالیت`);
  } catch {}
  if ((c.deals_count || 0) >= 5) badges.push(`${c.deals_count} معاملهٔ موفق`);
  if ((c.rating_count || 0) >= 3 && (c.rating_avg || 0) >= 4) badges.push('محبوب کاربران');
  const rt = responseTimes && responseTimes[c.id];
  if (rt && rt.reply_count >= 3 && rt.avg_minutes <= 120) badges.push('⚡ پاسخ‌گویی سریع');
  return badges;
}

// میانگین زمان پاسخ‌دهی هر شرکت در چت (بر حسب دقیقه)، برای نشان «پاسخ‌گویی سریع»
async function getResponseTimes(env, onlyCompanyId) {
  let sql = `
    WITH ordered AS (
      SELECT conversation_id, sender_company_id, created_at,
             LAG(sender_company_id) OVER (PARTITION BY conversation_id ORDER BY id) AS prev_sender,
             LAG(created_at) OVER (PARTITION BY conversation_id ORDER BY id) AS prev_time
      FROM messages
    )
    SELECT sender_company_id AS company_id,
           AVG((julianday(created_at) - julianday(prev_time)) * 24 * 60) AS avg_minutes,
           COUNT(*) AS reply_count
    FROM ordered
    WHERE prev_sender IS NOT NULL AND prev_sender != sender_company_id`;
  const binds = [];
  if (onlyCompanyId) { sql += ' AND sender_company_id = ?'; binds.push(onlyCompanyId); }
  sql += ' GROUP BY sender_company_id';
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  const map = {};
  results.forEach(r => { map[r.company_id] = r; });
  return map;
}

// ------------------------------------------------------------------
// عمومی: استان/شهرستان/دسته‌بندی
// ------------------------------------------------------------------
router.get('/api/provinces', async ({ env }) => {
  const { results } = await env.DB.prepare('SELECT * FROM provinces WHERE active=1').all();
  return json(results);
});
router.get('/api/counties', async ({ env }) => {
  const { results } = await env.DB.prepare('SELECT * FROM counties').all();
  return json(results);
});
router.get('/api/categories', async ({ env }) => {
  const { results } = await env.DB.prepare('SELECT * FROM categories WHERE active=1').all();
  return json(results);
});
router.get('/api/industrial-zones', async ({ env }) => {
  const { results } = await env.DB.prepare('SELECT id, name, county FROM industrial_zones ORDER BY county, name').all();
  return json(results);
});

// ------------------------------------------------------------------
// عمومی: فهرست واحدهای تولیدی
// ------------------------------------------------------------------
router.get('/api/companies/map', async ({ env }) => {
  const { results } = await env.DB.prepare(
    `SELECT id, name, county, category, role, verified, latitude, longitude
     FROM companies WHERE active=1 AND latitude IS NOT NULL AND longitude IS NOT NULL`
  ).all();
  return json(results);
});

router.get('/api/companies', async ({ env, url }) => {
  const q = url.searchParams.get('q') || '';
  const role = url.searchParams.get('role') || '';
  let sql = `SELECT id, name, county, province, category, products, capacity, role, verified, active, presentation_url, presentation_type, presentation_status, created_at, rating_avg, rating_count, deals_count
             FROM companies WHERE active=1`;
  const binds = [];
  if (q) { sql += ` AND name LIKE ?`; binds.push(`%${q}%`); }
  if (role) { sql += ` AND role = ?`; binds.push(role); }
  sql += ` ORDER BY verified DESC, created_at DESC LIMIT 100`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  const responseTimes = await getResponseTimes(env);
  results.forEach(c => { c.badges = computeBadges(c, responseTimes); });
  return json(results);
});

router.get('/api/companies/:id', async ({ env, params }) => {
  const c = await env.DB.prepare('SELECT * FROM companies WHERE id=?').bind(params.id).first();
  if (!c) return error('یافت نشد', 404);
  await env.DB.prepare('UPDATE companies SET profile_views = profile_views + 1 WHERE id=?').bind(params.id).run();
  delete c.password_hash;
  const responseTimes = await getResponseTimes(env, c.id);
  c.badges = computeBadges(c, responseTimes);
  return json(c);
});

// ------------------------------------------------------------------
// عمومی: عرضه‌ها
// ------------------------------------------------------------------
router.get('/api/offers', async ({ env, url }) => {
  const q = url.searchParams.get('q') || '';
  const county = url.searchParams.get('county') || '';
  const category = url.searchParams.get('category') || '';
  const companyId = url.searchParams.get('companyId') || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  let sql = `SELECT o.*, c.name as company_name, c.verified as company_verified
             FROM offers o JOIN companies c ON c.id = o.company_id
             WHERE o.active=1`;
  const binds = [];
  if (q) { sql += ` AND (o.title LIKE ? OR c.name LIKE ?)`; binds.push(`%${q}%`, `%${q}%`); }
  if (county) { sql += ` AND o.county = ?`; binds.push(county); }
  if (category) { sql += ` AND o.category = ?`; binds.push(category); }
  if (companyId) { sql += ` AND o.company_id = ?`; binds.push(companyId); }
  sql += ` ORDER BY (o.featured_approved=1) DESC, o.created_at DESC LIMIT ?`;
  binds.push(limit);
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return json(results);
});

router.get('/api/offers/:id', async ({ env, params }) => {
  const offer = await env.DB.prepare(
    `SELECT o.*, c.name as company_name, c.verified as company_verified, c.phone as company_phone
     FROM offers o JOIN companies c ON c.id=o.company_id WHERE o.id=?`
  ).bind(params.id).first();
  if (!offer) return error('یافت نشد', 404);
  await env.DB.prepare('UPDATE offers SET views = views + 1 WHERE id=?').bind(params.id).run();
  return json(offer);
});

// ثبت عرضه جدید — فقط برای کاربر واردشده، خودکار از پروفایل او پر می‌شود
router.post('/api/offers', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('برای ثبت آگهی ابتدا باید ثبت‌نام یا وارد شوید', 401);
  const company = await env.DB.prepare('SELECT * FROM companies WHERE id=?').bind(auth.companyId).first();
  if (!company) return error('حساب یافت نشد', 404);
  const b = await readJson(request);
  if (!b.title) return error('عنوان محصول الزامی است');
  const specs = JSON.stringify(b.specs || {});
  const res = await env.DB.prepare(
    `INSERT INTO offers (company_id, title, category, specs_json, price, unit, moq, payment, province, county, location, description, image_url)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(company.id, b.title, b.category || '', specs, b.price || '', b.unit || 'تومان', b.moq || '', b.payment || 'نقد',
         company.province || 'مرکزی', b.county || company.county || '', b.location || '', b.description || '', b.imageUrl || '').run();
  return json({ id: res.meta.last_row_id, companyId: company.id }, 201);
});

// درخواست استعلام قیمت روی یک عرضه — فقط برای کاربر واردشده
router.post('/api/rfqs', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('برای ارسال استعلام ابتدا باید ثبت‌نام یا وارد شوید', 401);
  const company = await env.DB.prepare('SELECT * FROM companies WHERE id=?').bind(auth.companyId).first();
  if (!company) return error('حساب یافت نشد', 404);
  const b = await readJson(request);
  if (!b.offerId) return error('آگهی مشخص نشده');
  const offer = await env.DB.prepare('SELECT company_id FROM offers WHERE id=?').bind(b.offerId).first();
  if (!offer) return error('آگهی یافت نشد', 404);
  if (offer.company_id === company.id) return error('نمی‌توانید برای آگهی خودتان استعلام ثبت کنید');
  const res = await env.DB.prepare(
    `INSERT INTO rfqs (offer_id, company_id, company_name, person_name, phone, quantity, message) VALUES (?,?,?,?,?,?,?)`
  ).bind(b.offerId, company.id, company.name, company.name, company.phone, b.quantity || '', b.message || '').run();
  return json({ id: res.meta.last_row_id }, 201);
});

// تطبیق هوشمند: وقتی درخواستی ثبت می‌شود، به شرکت‌های مرتبط همان شهرستان اعلان داخلی می‌فرستد
// نکته: فقط اعلان داخل‌برنامه‌ای می‌سازد؛ ارسال پیامک واقعی هنوز وصل نشده (نیاز به اطلاعات سرویس پیامک شما دارد)
async function notifyMatchingCompanies(env, { role, county, title, body, link, excludeCompanyId }) {
  let sql = `SELECT id FROM companies WHERE active=1 AND role=?`;
  const binds = [role];
  if (county) { sql += ' AND county=?'; binds.push(county); }
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  for (const c of results) {
    if (excludeCompanyId && c.id === excludeCompanyId) continue;
    await env.DB.prepare('INSERT INTO notifications (company_id, type, title, body, link) VALUES (?,?,?,?,?)')
      .bind(c.id, 'match_request', title, body || '', link || '').run();
  }
  return results.length;
}

// ------------------------------------------------------------------
// عمومی: درخواست‌های خرید
// ------------------------------------------------------------------
router.get('/api/requests', async ({ env }) => {
  const { results } = await env.DB.prepare(`SELECT * FROM purchase_requests ORDER BY created_at DESC LIMIT 100`).all();
  for (const r of results) {
    const c = await env.DB.prepare('SELECT COUNT(*) as c FROM request_responses WHERE request_id=?').bind(r.id).first();
    r.response_count = c.c;
  }
  return json(results);
});

router.post('/api/requests', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('برای ثبت درخواست خرید ابتدا باید ثبت‌نام یا وارد شوید', 401);
  const company = await env.DB.prepare('SELECT * FROM companies WHERE id=?').bind(auth.companyId).first();
  if (!company) return error('حساب یافت نشد', 404);
  const b = await readJson(request);
  if (!b.product || !b.quantity) return error('محصول و مقدار الزامی است');
  const res = await env.DB.prepare(
    `INSERT INTO purchase_requests (company_id, product, specs, quantity, unit, province, county, deadline, price_range, payment, description, company, contact_person, phone, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(company.id, b.product, b.specs || '', b.quantity, b.unit || 'تن', company.province || 'مرکزی', b.county || company.county || '',
         b.deadline || '', b.priceRange || '', b.payment || 'نقد', b.description || '', company.name, '', company.phone, b.status || 'معمولی').run();
  const reqCounty = b.county || company.county || '';
  notifyMatchingCompanies(env, {
    role: 'producer', county: reqCounty,
    title: `درخواست خرید جدید: ${b.product}`,
    body: `${b.quantity} ${b.unit || ''} در ${reqCounty || 'استان مرکزی'}`,
    link: `#request-${res.meta.last_row_id}`,
    excludeCompanyId: company.id,
  }).catch(() => {});
  return json({ id: res.meta.last_row_id }, 201);
});

router.post('/api/requests/:id/respond', async ({ request, env, params }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('برای اعلام آمادگی ابتدا باید ثبت‌نام یا وارد شوید', 401);
  const company = await env.DB.prepare('SELECT * FROM companies WHERE id=?').bind(auth.companyId).first();
  if (!company) return error('حساب یافت نشد', 404);
  const reqRow = await env.DB.prepare('SELECT company_id FROM purchase_requests WHERE id=?').bind(params.id).first();
  if (!reqRow) return error('درخواست یافت نشد', 404);
  if (reqRow.company_id === company.id) return error('نمی‌توانید برای درخواست خرید خودتان اعلام آمادگی کنید');
  await env.DB.prepare(
    `INSERT INTO request_responses (request_id, company_id, company_name, phone) VALUES (?,?,?,?)`
  ).bind(params.id, company.id, company.name, company.phone).run();
  return json({ ok: true }, 201);
});

// ------------------------------------------------------------------
// عمومی: درخواست خدمات تخصصی/نیروی انسانی
// ------------------------------------------------------------------
router.get('/api/service-requests', async ({ env }) => {
  const { results } = await env.DB.prepare(`SELECT * FROM service_requests ORDER BY created_at DESC LIMIT 100`).all();
  return json(results);
});
router.post('/api/service-requests', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('برای ثبت درخواست خدمات ابتدا باید ثبت‌نام یا وارد شوید', 401);
  const company = await env.DB.prepare('SELECT * FROM companies WHERE id=?').bind(auth.companyId).first();
  if (!company) return error('حساب یافت نشد', 404);
  const b = await readJson(request);
  if (!b.roleTitle) return error('عنوان نیاز الزامی است');
  const res = await env.DB.prepare(
    `INSERT INTO service_requests (company_id, role_title, service_category, description, province, county, company, contact_person, phone, urgency)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(company.id, b.roleTitle, b.serviceCategory || '', b.description || '', company.province || 'مرکزی', b.county || company.county || '',
         company.name, '', company.phone, b.urgency || 'معمولی').run();
  const reqCounty2 = b.county || company.county || '';
  notifyMatchingCompanies(env, {
    role: 'service', county: reqCounty2,
    title: `درخواست خدمات جدید: ${b.roleTitle}`,
    body: `${b.serviceCategory || ''} در ${reqCounty2 || 'استان مرکزی'}`,
    link: `#service-request-${res.meta.last_row_id}`,
    excludeCompanyId: company.id,
  }).catch(() => {});
  return json({ id: res.meta.last_row_id }, 201);
});

// تنظیمات سراسری پلتفرم (فعلاً فقط چت)
async function getPlatformSettings(env) {
  const row = await env.DB.prepare('SELECT * FROM platform_settings WHERE id=1').first();
  return row || { chat_enabled: 1, chat_auto_approve: 1 };
}
router.get('/api/platform-settings', async ({ env }) => {
  const s = await getPlatformSettings(env);
  return json({ chat_enabled: s.chat_enabled });
});

// ------------------------------------------------------------------
// چت داخلی بین دو شرکت (خریدار/فروشنده) — بدون نیاز به واتس‌اپ
// ------------------------------------------------------------------
router.post('/api/chat/start', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('برای شروع گفتگو ابتدا وارد شوید', 401);
  const settings = await getPlatformSettings(env);
  if (!settings.chat_enabled) return error('گفتگوی داخلی پلتفرم موقتاً توسط مدیریت غیرفعال شده است', 403);
  const b = await readJson(request);
  const otherId = parseInt(b.companyId);
  if (!otherId || otherId === auth.companyId) return error('شرکت مقصد نامعتبر است');
  const other = await env.DB.prepare('SELECT id FROM companies WHERE id=? AND active=1').bind(otherId).first();
  if (!other) return error('شرکت مقصد یافت نشد', 404);
  const a = Math.min(auth.companyId, otherId), bId = Math.max(auth.companyId, otherId);
  let convo = await env.DB.prepare('SELECT * FROM conversations WHERE company_a_id=? AND company_b_id=?').bind(a, bId).first();
  if (!convo) {
    const res = await env.DB.prepare(
      `INSERT INTO conversations (company_a_id, company_b_id, related_type, related_id, initiator_company_id, approved) VALUES (?,?,?,?,?,?)`
    ).bind(a, bId, b.relatedType || null, b.relatedId || null, auth.companyId, settings.chat_auto_approve ? 1 : 0).run();
    convo = { id: res.meta.last_row_id };
  }
  return json({ conversationId: convo.id });
});

router.get('/api/chat/conversations', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('ورود لازم است', 401);
  const { results: raw } = await env.DB.prepare(`
    SELECT c.*, CASE WHEN c.company_a_id=? THEN c.company_b_id ELSE c.company_a_id END AS other_id
    FROM conversations c WHERE c.company_a_id=? OR c.company_b_id=?
    ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
  `).bind(auth.companyId, auth.companyId, auth.companyId).all();
  // اگر گفتگو هنوز تایید نشده، فقط شروع‌کننده آن را می‌بیند (با برچسب «در انتظار تایید»)
  const results = raw.filter(c => c.approved || c.initiator_company_id === auth.companyId);
  for (const c of results) {
    c.pending_approval = !c.approved;
    const other = await env.DB.prepare('SELECT id, name FROM companies WHERE id=?').bind(c.other_id).first();
    c.other_name = other?.name || 'کاربر حذف‌شده';
    const lastMsg = await env.DB.prepare('SELECT body FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1').bind(c.id).first();
    c.last_message = lastMsg?.body || '';
    const read = await env.DB.prepare('SELECT last_read_at FROM conversation_reads WHERE conversation_id=? AND company_id=?').bind(c.id, auth.companyId).first();
    const since = read?.last_read_at || '1970-01-01';
    const unread = await env.DB.prepare('SELECT COUNT(*) c FROM messages WHERE conversation_id=? AND created_at>? AND sender_company_id!=?').bind(c.id, since, auth.companyId).first();
    c.unread_count = unread.c;
  }
  return json(results);
});

router.get('/api/chat/conversations/:id/messages', async ({ request, env, params }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('ورود لازم است', 401);
  const convo = await env.DB.prepare('SELECT * FROM conversations WHERE id=?').bind(params.id).first();
  if (!convo || (convo.company_a_id !== auth.companyId && convo.company_b_id !== auth.companyId)) return error('دسترسی ندارید', 403);
  if (!convo.approved && convo.initiator_company_id !== auth.companyId) return error('این گفتگو هنوز توسط مدیریت تایید نشده است', 403);
  const { results } = await env.DB.prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY id ASC').bind(params.id).all();
  await env.DB.prepare(
    `INSERT INTO conversation_reads (conversation_id, company_id, last_read_at) VALUES (?,?,datetime('now'))
     ON CONFLICT(conversation_id, company_id) DO UPDATE SET last_read_at=datetime('now')`
  ).bind(params.id, auth.companyId).run();
  return json(results);
});

router.post('/api/chat/conversations/:id/messages', async ({ request, env, params }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('ورود لازم است', 401);
  const settings = await getPlatformSettings(env);
  if (!settings.chat_enabled) return error('گفتگوی داخلی پلتفرم موقتاً توسط مدیریت غیرفعال شده است', 403);
  const convo = await env.DB.prepare('SELECT * FROM conversations WHERE id=?').bind(params.id).first();
  if (!convo || (convo.company_a_id !== auth.companyId && convo.company_b_id !== auth.companyId)) return error('دسترسی ندارید', 403);
  if (convo.status === 'closed_by_admin') return error('این گفتگو توسط مدیریت بسته شده است', 403);
  if (!convo.approved && convo.initiator_company_id !== auth.companyId) return error('این گفتگو هنوز توسط مدیریت تایید نشده است', 403);
  const b = await readJson(request);
  if (!b.body || !b.body.trim()) return error('متن پیام خالی است');
  const res = await env.DB.prepare('INSERT INTO messages (conversation_id, sender_company_id, body) VALUES (?,?,?)')
    .bind(params.id, auth.companyId, b.body.trim()).run();
  await env.DB.prepare(`UPDATE conversations SET last_message_at=datetime('now') WHERE id=?`).bind(params.id).run();
  if (convo.approved) {
    const otherId = convo.company_a_id === auth.companyId ? convo.company_b_id : convo.company_a_id;
    const me = await env.DB.prepare('SELECT name FROM companies WHERE id=?').bind(auth.companyId).first();
    await env.DB.prepare('INSERT INTO notifications (company_id, type, title, body, link) VALUES (?,?,?,?,?)')
      .bind(otherId, 'message', `پیام جدید از ${me?.name || ''}`, b.body.trim().slice(0, 80), `#chat-${params.id}`).run();
  }
  return json({ id: res.meta.last_row_id }, 201);
});

router.post('/api/chat/messages/:id/report', async ({ request, env, params }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('ورود لازم است', 401);
  const msg = await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(params.id).first();
  if (!msg) return error('پیام یافت نشد', 404);
  const b = await readJson(request);
  await env.DB.prepare('INSERT INTO message_reports (message_id, conversation_id, reported_by_company_id, reason) VALUES (?,?,?,?)')
    .bind(params.id, msg.conversation_id, auth.companyId, b.reason || '').run();
  return json({ ok: true }, 201);
});

// ------------------------------------------------------------------
// امتیاز و نظر بعد از معامله (بعد از تایید مدیر عمومی می‌شود)
// ------------------------------------------------------------------
router.post('/api/reviews', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('برای ثبت نظر ابتدا وارد شوید', 401);
  const b = await readJson(request);
  const targetId = parseInt(b.companyId);
  const rating = parseInt(b.rating);
  if (!targetId || !rating || rating < 1 || rating > 5) return error('انتخاب شرکت و امتیاز بین ۱ تا ۵ الزامی است');
  if (targetId === auth.companyId) return error('نمی‌توانید برای شرکت خودتان نظر ثبت کنید');
  await env.DB.prepare('INSERT INTO reviews (company_id, reviewer_company_id, rating, comment) VALUES (?,?,?,?)')
    .bind(targetId, auth.companyId, rating, (b.comment || '').trim()).run();
  return json({ ok: true, note: 'نظر شما بعد از تایید مدیریت نمایش داده می‌شود' }, 201);
});

router.get('/api/companies/:id/reviews', async ({ env, params }) => {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.rating, r.comment, r.created_at, c.name AS reviewer_name
     FROM reviews r JOIN companies c ON c.id = r.reviewer_company_id
     WHERE r.company_id=? AND r.status='approved' ORDER BY r.created_at DESC`
  ).bind(params.id).all();
  return json(results);
});

// ------------------------------------------------------------------
// اعلان‌های داخل‌برنامه‌ای شرکت (زنگوله)
// ------------------------------------------------------------------
router.get('/api/company/weekly-digest', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('ورود لازم است', 401);
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const views = await env.DB.prepare(`SELECT COUNT(*) c FROM page_views WHERE path=? AND created_at>=?`)
    .bind(`/company/${auth.companyId}`, since).first();
  const newMessages = await env.DB.prepare(`
    SELECT COUNT(*) c FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
    WHERE (cv.company_a_id=? OR cv.company_b_id=?) AND m.sender_company_id != ? AND m.created_at >= ?
  `).bind(auth.companyId, auth.companyId, auth.companyId, since).first();
  const newRfqs = await env.DB.prepare(`
    SELECT COUNT(*) c FROM rfqs r JOIN offers o ON o.id = r.offer_id WHERE o.company_id=? AND r.created_at>=?
  `).bind(auth.companyId, since).first();
  const newMatches = await env.DB.prepare(`SELECT COUNT(*) c FROM notifications WHERE company_id=? AND type='match_request' AND created_at>=?`)
    .bind(auth.companyId, since).first();
  return json({ views: views.c, newMessages: newMessages.c, newRfqs: newRfqs.c, newMatches: newMatches.c });
});

router.get('/api/company/inbox', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('ورود لازم است', 401);
  const { results } = await env.DB.prepare('SELECT * FROM notifications WHERE company_id=? ORDER BY id DESC LIMIT 50').bind(auth.companyId).all();
  const unread = await env.DB.prepare('SELECT COUNT(*) c FROM notifications WHERE company_id=? AND is_read=0').bind(auth.companyId).first();
  return json({ items: results, unread: unread.c });
});
router.post('/api/company/inbox/:id/read', async ({ request, env, params }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('ورود لازم است', 401);
  await env.DB.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND company_id=?').bind(params.id, auth.companyId).run();
  return json({ ok: true });
});
router.post('/api/company/inbox/read-all', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('ورود لازم است', 401);
  await env.DB.prepare('UPDATE notifications SET is_read=1 WHERE company_id=?').bind(auth.companyId).run();
  return json({ ok: true });
});

// ------------------------------------------------------------------
// تیکر آمار روزانهٔ صفحهٔ اصلی
// ------------------------------------------------------------------
router.get('/api/stats/ticker', async ({ env }) => {
  const today = new Date().toISOString().slice(0, 10);
  const reqToday = await env.DB.prepare(`SELECT COUNT(*) c FROM purchase_requests WHERE created_at LIKE ?`).bind(today + '%').first();
  const svcToday = await env.DB.prepare(`SELECT COUNT(*) c FROM service_requests WHERE created_at LIKE ?`).bind(today + '%').first();
  const companiesTotal = await env.DB.prepare(`SELECT COUNT(*) c FROM companies WHERE active=1`).first();
  return json({ requestsToday: (reqToday.c || 0) + (svcToday.c || 0), companiesTotal: companiesTotal.c || 0 });
});

// ------------------------------------------------------------------
// عمومی: مشکلات صنعتی
// ------------------------------------------------------------------
router.get('/api/problems', async ({ env }) => {
  const { results } = await env.DB.prepare(`SELECT * FROM problems ORDER BY created_at DESC LIMIT 100`).all();
  return json(results);
});
router.post('/api/problems', async ({ request, env }) => {
  const b = await readJson(request);
  if (!b.title || !b.phone) return error('عنوان و شماره تماس الزامی است');
  const res = await env.DB.prepare(
    `INSERT INTO problems (title, description, category, province, county, urgency, company, phone)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(b.title, b.description || '', b.category || '', b.province || 'مرکزی', b.county || '',
         b.urgency || 'معمولی', b.company || '', b.phone).run();
  return json({ id: res.meta.last_row_id }, 201);
});

// ------------------------------------------------------------------
// عمومی: تماس با ما / پیشنهاد / پشتیبانی (بدون نیاز به ورود)
// ------------------------------------------------------------------
router.post('/api/contact', async ({ request, env }) => {
  const b = await readJson(request);
  if (!b.message) return error('متن پیام الزامی است');
  let companyId = null;
  const auth = await requireCompany(request, env);
  if (auth) companyId = auth.companyId;
  const res = await env.DB.prepare(
    `INSERT INTO contact_messages (company_id, name, phone, subject, message) VALUES (?,?,?,?,?)`
  ).bind(companyId, b.name || '', b.phone || '', b.subject || '', b.message).run();
  return json({ id: res.meta.last_row_id, message: 'پیام شما ارسال شد.' }, 201);
});

// ------------------------------------------------------------------
// عمومی: تبلیغات (نمایش فعال‌ها + ثبت درخواست تبلیغ)
// ------------------------------------------------------------------
router.get('/api/ads/active', async ({ env }) => {
  const today = new Date().toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    `SELECT * FROM ads WHERE status='approved' AND (start_date IS NULL OR start_date <= ?) AND (end_date IS NULL OR end_date >= ?)
     ORDER BY created_at DESC LIMIT 5`
  ).bind(today, today).all();
  return json(results);
});
router.post('/api/ads', async ({ request, env }) => {
  const b = await readJson(request);
  if (!b.adType || !b.advertiserPhone) return error('نوع تبلیغ و شماره تماس الزامی است');
  const res = await env.DB.prepare(
    `INSERT INTO ads (ad_type, title, body_text, image_url, video_embed_url, link_url, advertiser_name, advertiser_phone)
     VALUES (?,?,?,?,?,?,?,?)`
  ).bind(b.adType, b.title || '', b.bodyText || '', b.imageUrl || '', b.videoEmbedUrl || '', b.linkUrl || '',
         b.advertiserName || '', b.advertiserPhone).run();
  return json({ id: res.meta.last_row_id, message: 'درخواست تبلیغ ثبت شد و پس از تایید مدیر نمایش داده می‌شود.' }, 201);
});

// ------------------------------------------------------------------
// عمومی: فایل‌های مفید مدیر
// ------------------------------------------------------------------
router.get('/api/admin-files', async ({ env }) => {
  const { results } = await env.DB.prepare(`SELECT id, title, description, file_type, is_locked, price,
    CASE WHEN is_locked=0 THEN file_url ELSE NULL END as file_url
    FROM admin_files ORDER BY created_at DESC`).all();
  return json(results);
});

// ------------------------------------------------------------------
// عمومی: ابزار محاسبه بهای تمام‌شده (کاملاً سمت سرور بدون منبع خارجی)
// ------------------------------------------------------------------
router.get('/api/calculator-settings', async ({ env }) => {
  const row = await env.DB.prepare('SELECT * FROM calculator_settings WHERE id=1').first();
  return json(row);
});
router.post('/api/calculate-cost', async ({ request }) => {
  const b = await readJson(request);
  const material = parseFloat(b.materialCost || 0);
  const labor = parseFloat(b.laborCost || 0);
  const overheadPercent = parseFloat(b.overheadPercent || 0);
  const quantity = parseFloat(b.quantity || 1) || 1;
  const profitPercent = parseFloat(b.profitPercent || 0);
  const directCost = material + labor;
  const overhead = directCost * (overheadPercent / 100);
  const totalCost = directCost + overhead;
  const unitCost = totalCost / quantity;
  const suggestedPrice = unitCost * (1 + profitPercent / 100);
  return json({ directCost, overhead, totalCost, unitCost, suggestedPrice });
});

// ------------------------------------------------------------------
// آمار بازدید داخلی (سبک)
// ------------------------------------------------------------------
router.post('/api/track', async ({ request, env }) => {
  const b = await readJson(request);
  await env.DB.prepare('INSERT INTO page_views (path, ref) VALUES (?,?)').bind(b.path || '/', b.ref || '').run();
  return json({ ok: true }, 201);
});

// ------------------------------------------------------------------
// پنل کارخانه: ورود / پروفایل / داشبورد / ویرایش (در انتظار تایید)
// ------------------------------------------------------------------
const VALID_ROLES = ['producer', 'service', 'buyer', 'other'];
router.post('/api/company/register', async ({ request, env }) => {
  const b = await readJson(request);
  if (!b.name || !b.phone || !b.password || !b.role) return error('نام، شماره تماس، رمز عبور و نوع فعالیت الزامی است');
  if (!VALID_ROLES.includes(b.role)) return error('نوع فعالیت نامعتبر است');
  const exists = await env.DB.prepare('SELECT id FROM companies WHERE phone=?').bind(b.phone).first();
  if (exists) return error('این شماره قبلاً ثبت شده؛ از فرم ورود استفاده کنید', 409);
  const pw = await hashPassword(b.password);
  // موقعیت (نقشه یا شهرک صنعتی انتخاب‌شده) همین‌جا مستقیم ثبت می‌شود؛ چون بخشی از
  // اطلاعات اولیهٔ خودِ کاربر است، نیازی به تایید مدیر برای اعمال‌شدن ندارد
  const res = await env.DB.prepare(
    `INSERT INTO companies (name, phone, password_hash, role, province, county, latitude, longitude, industrial_zone, profile_completed)
     VALUES (?,?,?,?,?,?,?,?,?,0)`
  ).bind(
    b.name, b.phone, pw, b.role, 'مرکزی', b.county || '',
    (typeof b.latitude === 'number') ? b.latitude : null,
    (typeof b.longitude === 'number') ? b.longitude : null,
    b.industrialZone || null
  ).run();
  const token = await signToken({ role: 'company', companyId: res.meta.last_row_id }, env.JWT_SECRET);
  return json({ id: res.meta.last_row_id, token, message: 'ثبت‌نام شما انجام شد.' }, 201);
});

// نمایش سریع نام کاربر برای بالای صفحه (بدون بار سنگین داشبورد کامل)
router.get('/api/company/me', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('نیاز به ورود', 401);
  const company = await env.DB.prepare('SELECT id, name, role, verified FROM companies WHERE id=?').bind(auth.companyId).first();
  if (!company) return error('حساب یافت نشد', 404);
  return json(company);
});

router.post('/api/company/login', async ({ request, env }) => {
  const b = await readJson(request);
  const ip = clientIp(request);
  if (await tooManyAttempts(env.DB, 'company', b.phone || '', ip)) return error('تعداد تلاش بیش از حد مجاز؛ کمی بعد دوباره تلاش کنید', 429);
  const company = await env.DB.prepare('SELECT * FROM companies WHERE phone=?').bind(b.phone || '').first();
  const ok = company && company.password_hash && await verifyPassword(b.password || '', company.password_hash);
  await recordAttempt(env.DB, 'company', b.phone || '', ip, !!ok);
  if (!ok) return error('شماره یا رمز عبور اشتباه است', 401);
  const token = await signToken({ role: 'company', companyId: company.id }, env.JWT_SECRET);
  return json({ token, company: pick(company, ['id', 'name', 'phone', 'role', 'verified', 'active', 'profile_completed']) });
});

router.get('/api/company/dashboard', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('نیاز به ورود', 401);
  const cid = auth.companyId;
  const company = await env.DB.prepare('SELECT * FROM companies WHERE id=?').bind(cid).first();
  const offersCount = await env.DB.prepare('SELECT COUNT(*) c FROM offers WHERE company_id=?').bind(cid).first();
  const rfqCount = await env.DB.prepare(
    `SELECT COUNT(*) c FROM rfqs r JOIN offers o ON o.id=r.offer_id WHERE o.company_id=?`
  ).bind(cid).first();
  const respCount = await env.DB.prepare('SELECT COUNT(*) c FROM request_responses WHERE company_id=?').bind(cid).first();
  const myRequestsCount = await env.DB.prepare('SELECT COUNT(*) c FROM purchase_requests WHERE company_id=?').bind(cid).first();
  const myServiceCount = await env.DB.prepare('SELECT COUNT(*) c FROM service_requests WHERE company_id=?').bind(cid).first();
  const { results: myServices } = await env.DB.prepare('SELECT * FROM service_requests WHERE company_id=? ORDER BY created_at DESC').bind(cid).all();
  const { results: myOffers } = await env.DB.prepare('SELECT id, title, price, active, verified, views FROM offers WHERE company_id=? ORDER BY created_at DESC').bind(cid).all();

  // درخواست‌های خرید من + پاسخ‌هایی که تأمین‌کننده‌ها داده‌اند (با مشخصات تماس)
  const { results: myRequests } = await env.DB.prepare('SELECT * FROM purchase_requests WHERE company_id=? ORDER BY created_at DESC').bind(cid).all();
  for (const r of myRequests) {
    const { results: responses } = await env.DB.prepare('SELECT company_name, phone, created_at FROM request_responses WHERE request_id=?').bind(r.id).all();
    r.responses = responses;
  }

  // استعلام‌هایی که من فرستاده‌ام
  const { results: myRfqsSent } = await env.DB.prepare(
    `SELECT rfqs.*, offers.title as offer_title FROM rfqs JOIN offers ON offers.id = rfqs.offer_id WHERE rfqs.company_id=? ORDER BY rfqs.created_at DESC`
  ).bind(cid).all();

  // استعلام‌هایی که روی آگهی‌های من دریافت شده (اگر آگهی دارم)
  const { results: rfqsReceived } = await env.DB.prepare(
    `SELECT rfqs.*, offers.title as offer_title FROM rfqs JOIN offers ON offers.id = rfqs.offer_id WHERE offers.company_id=? ORDER BY rfqs.created_at DESC`
  ).bind(cid).all();

  const { results: monthlyViews } = await env.DB.prepare(
    `SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as c FROM page_views
     WHERE path LIKE ('%/company/' || ? || '%') GROUP BY month ORDER BY month DESC LIMIT 6`
  ).bind(cid).all();
  return json({
    company: pick(company, ['id', 'name', 'phone', 'role', 'verified', 'active', 'profile_views', 'presentation_status', 'profile_completed', 'county', 'category', 'products', 'capacity', 'latitude', 'longitude', 'industrial_zone', 'logo_url']),
    stats: { offers: offersCount.c, rfqs: rfqCount.c, responses: respCount.c, profileViews: company.profile_views, myRequests: myRequestsCount.c, myServices: myServiceCount.c },
    myOffers, myRequests, myServices, myRfqsSent, rfqsReceived, monthlyViews,
  });
});

router.post('/api/company/change-password', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('ورود لازم است', 401);
  const b = await readJson(request);
  if (!b.newPassword || b.newPassword.length < 4) return error('رمز جدید باید حداقل ۴ کاراکتر باشد');
  const company = await env.DB.prepare('SELECT * FROM companies WHERE id=?').bind(auth.companyId).first();
  if (!company) return error('حساب یافت نشد', 404);
  if (!(await verifyPassword(b.currentPassword || '', company.password_hash))) return error('رمز فعلی درست نیست');
  const pw = await hashPassword(b.newPassword);
  await env.DB.prepare('UPDATE companies SET password_hash=? WHERE id=?').bind(pw, auth.companyId).run();
  return json({ ok: true });
});

router.put('/api/company/profile', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('نیاز به ورود', 401);
  const b = await readJson(request);
  const changes = pick(b, ['name', 'county', 'category', 'products', 'capacity', 'logo_url', 'license_url', 'latitude', 'longitude', 'industrial_zone']);
  await env.DB.prepare(
    `INSERT INTO pending_edits (entity_type, entity_id, company_id, changes_json) VALUES ('company', ?, ?, ?)`
  ).bind(auth.companyId, auth.companyId, JSON.stringify(changes)).run();
  await env.DB.prepare(`UPDATE companies SET profile_completed=1 WHERE id=?`).bind(auth.companyId).run();
  return json({ ok: true, message: 'تغییرات ثبت شد و پس از تایید مدیر اعمال می‌شود.' }, 201);
});

router.put('/api/company/offers/:id', async ({ request, env, params }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('نیاز به ورود', 401);
  const offer = await env.DB.prepare('SELECT * FROM offers WHERE id=? AND company_id=?').bind(params.id, auth.companyId).first();
  if (!offer) return error('این آگهی متعلق به شما نیست', 403);
  const b = await readJson(request);
  const changes = pick(b, ['title', 'price', 'unit', 'moq', 'payment', 'description', 'specs_json', 'active']);
  await env.DB.prepare(
    `INSERT INTO pending_edits (entity_type, entity_id, company_id, changes_json) VALUES ('offer', ?, ?, ?)`
  ).bind(params.id, auth.companyId, JSON.stringify(changes)).run();
  return json({ ok: true, message: 'تغییرات ثبت شد و پس از تایید مدیر اعمال می‌شود.' }, 201);
});

router.del('/api/company/offers/:id', async ({ request, env, params }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('نیاز به ورود', 401);
  const offer = await env.DB.prepare('SELECT * FROM offers WHERE id=? AND company_id=?').bind(params.id, auth.companyId).first();
  if (!offer) return error('این آگهی متعلق به شما نیست', 403);
  await env.DB.prepare('DELETE FROM rfqs WHERE offer_id=?').bind(params.id).run();
  await env.DB.prepare(`DELETE FROM pending_edits WHERE entity_type='offer' AND entity_id=?`).bind(params.id).run();
  await env.DB.prepare('DELETE FROM offers WHERE id=?').bind(params.id).run();
  return json({ ok: true });
});

router.put('/api/company/service-requests/:id', async ({ request, env, params }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('نیاز به ورود', 401);
  const item = await env.DB.prepare('SELECT * FROM service_requests WHERE id=? AND company_id=?').bind(params.id, auth.companyId).first();
  if (!item) return error('این درخواست متعلق به شما نیست', 403);
  const b = await readJson(request);
  const changes = pick(b, ['role_title', 'service_category', 'description', 'urgency', 'status']);
  await env.DB.prepare(
    `INSERT INTO pending_edits (entity_type, entity_id, company_id, changes_json) VALUES ('service_request', ?, ?, ?)`
  ).bind(params.id, auth.companyId, JSON.stringify(changes)).run();
  return json({ ok: true, message: 'تغییرات ثبت شد و پس از تایید مدیر اعمال می‌شود.' }, 201);
});

router.del('/api/company/service-requests/:id', async ({ request, env, params }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('نیاز به ورود', 401);
  const item = await env.DB.prepare('SELECT * FROM service_requests WHERE id=? AND company_id=?').bind(params.id, auth.companyId).first();
  if (!item) return error('این درخواست متعلق به شما نیست', 403);
  await env.DB.prepare(`DELETE FROM pending_edits WHERE entity_type='service_request' AND entity_id=?`).bind(params.id).run();
  await env.DB.prepare('DELETE FROM service_requests WHERE id=?').bind(params.id).run();
  return json({ ok: true });
});

router.del('/api/company/requests/:id', async ({ request, env, params }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('نیاز به ورود', 401);
  const item = await env.DB.prepare('SELECT * FROM purchase_requests WHERE id=? AND company_id=?').bind(params.id, auth.companyId).first();
  if (!item) return error('این درخواست متعلق به شما نیست', 403);
  await env.DB.prepare('DELETE FROM request_responses WHERE request_id=?').bind(params.id).run();
  await env.DB.prepare('DELETE FROM purchase_requests WHERE id=?').bind(params.id).run();
  return json({ ok: true });
});

router.post('/api/company/presentation', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('نیاز به ورود', 401);
  const b = await readJson(request);
  await env.DB.prepare(
    `UPDATE companies SET presentation_url=?, presentation_type=?, presentation_status='pending' WHERE id=?`
  ).bind(b.url || '', b.type || 'video_link', auth.companyId).run();
  return json({ ok: true, message: 'ارسال شد و در انتظار تایید مدیر است.' });
});

// ------------------------------------------------------------------
// راه‌اندازی اولیه: ساخت اولین حساب مدیر (فقط یک‌بار قابل استفاده است)
// ------------------------------------------------------------------
router.post('/api/setup/create-admin', async ({ request, env }) => {
  const existing = await env.DB.prepare('SELECT COUNT(*) c FROM admin_users').first();
  if (existing.c > 0) return error('حساب مدیر قبلاً ساخته شده؛ این مسیر دیگر فعال نیست', 403);
  const key = request.headers.get('X-Setup-Key');
  if (!key || key !== env.SETUP_KEY) return error('کلید راه‌اندازی نامعتبر است', 401);
  const b = await readJson(request);
  if (!b.username || !b.password) return error('نام کاربری و رمز عبور الزامی است');
  const pw = await hashPassword(b.password);
  await env.DB.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?,?)').bind(b.username, pw).run();
  return json({ ok: true, message: 'حساب مدیر ساخته شد. حالا از فرم ورود پنل مدیریت استفاده کنید.' }, 201);
});

// ------------------------------------------------------------------
// پنل مدیریت (مخفی): ورود
// ------------------------------------------------------------------
router.post('/api/admin/login', async ({ request, env }) => {
  const b = await readJson(request);
  const ip = clientIp(request);
  if (await tooManyAttempts(env.DB, 'admin', b.username || '', ip)) return error('تعداد تلاش بیش از حد مجاز؛ کمی بعد دوباره تلاش کنید', 429);
  const admin = await env.DB.prepare('SELECT * FROM admin_users WHERE username=?').bind(b.username || '').first();
  const ok = admin && await verifyPassword(b.password || '', admin.password_hash);
  await recordAttempt(env.DB, 'admin', b.username || '', ip, !!ok);
  if (!ok) return error('نام کاربری یا رمز اشتباه است', 401);
  const token = await signToken({ role: 'admin', adminId: admin.id, username: admin.username }, env.JWT_SECRET, 60 * 60 * 12);
  return json({ token });
});

// ------------------------------------------------------------------
// پنل مدیریت: CRUD عمومی برای جدول‌های ساده
// ------------------------------------------------------------------
const SIMPLE_TABLES = {
  categories: ['name', 'active'],
  provinces: ['name', 'active'],
  counties: ['name', 'province_id'],
  'admin-files': { table: 'admin_files', cols: ['title', 'description', 'file_url', 'file_type', 'is_locked', 'price'] },
};

function tableInfo(key) {
  const v = SIMPLE_TABLES[key];
  if (!v) return null;
  return Array.isArray(v) ? { table: key, cols: v } : v;
}

for (const key of Object.keys(SIMPLE_TABLES)) {
  router.get(`/api/admin/${key}`, async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
    const { table } = tableInfo(key);
    const { results } = await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id DESC`).all();
    return json(results);
  });
  router.post(`/api/admin/${key}`, async ({ request, env }) => {
    if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
    const { table, cols } = tableInfo(key);
    const b = await readJson(request);
    const values = cols.map(c => b[c] ?? null);
    const placeholders = cols.map(() => '?').join(',');
    const res = await env.DB.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`).bind(...values).run();
    return json({ id: res.meta.last_row_id }, 201);
  });
  router.put(`/api/admin/${key}/:id`, async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
    const { table, cols } = tableInfo(key);
    const b = await readJson(request);
    const setCols = cols.filter(c => b[c] !== undefined);
    if (!setCols.length) return error('چیزی برای تغییر ارسال نشده');
    const setSql = setCols.map(c => `${c}=?`).join(',');
    const values = setCols.map(c => b[c]);
    await env.DB.prepare(`UPDATE ${table} SET ${setSql} WHERE id=?`).bind(...values, params.id).run();
    return json({ ok: true });
  });
  router.del(`/api/admin/${key}/:id`, async ({ request, env, params }) => {
    if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
    const { table } = tableInfo(key);
    await env.DB.prepare(`DELETE FROM ${table} WHERE id=?`).bind(params.id).run();
    return json({ ok: true });
  });
}

// ------------------------------------------------------------------
// پنل مدیریت: عرضه‌ها، درخواست‌ها، شرکت‌ها، خدمات، مشکلات (با فیلدهای خاص خودشان)
// ------------------------------------------------------------------
router.get('/api/admin/offers', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare(
    `SELECT o.*, c.name as company_name FROM offers o JOIN companies c ON c.id=o.company_id ORDER BY o.created_at DESC`
  ).all();
  return json(results);
});
router.put('/api/admin/offers/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  const cols = ['title', 'category', 'price', 'unit', 'moq', 'payment', 'description', 'verified', 'active', 'featured', 'featured_approved'];
  const setCols = cols.filter(c => b[c] !== undefined);
  if (!setCols.length) return error('چیزی برای تغییر ارسال نشده');
  await env.DB.prepare(`UPDATE offers SET ${setCols.map(c => c + '=?').join(',')} WHERE id=?`)
    .bind(...setCols.map(c => b[c]), params.id).run();
  return json({ ok: true });
});
router.del('/api/admin/offers/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  await env.DB.prepare('DELETE FROM rfqs WHERE offer_id=?').bind(params.id).run();
  await env.DB.prepare(`DELETE FROM pending_edits WHERE entity_type='offer' AND entity_id=?`).bind(params.id).run();
  await env.DB.prepare('DELETE FROM offers WHERE id=?').bind(params.id).run();
  return json({ ok: true });
});

// ------------------------------------------------------------------
// مدیریت: دسته‌بندی‌ها، شهرستان‌ها، شهرک/ناحیه‌های صنعتی
// ------------------------------------------------------------------
router.get('/api/admin/categories', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare('SELECT * FROM categories ORDER BY name').all();
  return json(results);
});
router.post('/api/admin/categories', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  if (!b.name) return error('نام دسته الزامی است');
  await env.DB.prepare('INSERT OR IGNORE INTO categories (name, active) VALUES (?,?)').bind(b.name.trim(), b.active ?? 1).run();
  return json({ ok: true }, 201);
});
router.del('/api/admin/categories/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  await env.DB.prepare('DELETE FROM categories WHERE id=?').bind(params.id).run();
  return json({ ok: true });
});

router.get('/api/admin/counties', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare('SELECT * FROM counties ORDER BY name').all();
  return json(results);
});
router.post('/api/admin/counties', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  if (!b.name) return error('نام شهرستان الزامی است');
  await env.DB.prepare('INSERT INTO counties (name, province_id) VALUES (?,?)').bind(b.name.trim(), b.province_id || 1).run();
  return json({ ok: true }, 201);
});
router.del('/api/admin/counties/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  await env.DB.prepare('DELETE FROM counties WHERE id=?').bind(params.id).run();
  return json({ ok: true });
});

// شهرک‌ها/نواحی صنعتی — همان فهرستی که در نقشهٔ ثبت‌نام کارخانه‌ها استفاده می‌شود
router.get('/api/admin/industrial-zones', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare('SELECT * FROM industrial_zones ORDER BY county, name').all();
  return json(results);
});
router.post('/api/admin/industrial-zones', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  if (!b.name || !b.county) return error('نام شهرک و شهرستان الزامی است');
  await env.DB.prepare('INSERT INTO industrial_zones (name, county) VALUES (?,?)').bind(b.name.trim(), b.county).run();
  return json({ ok: true }, 201);
});
router.put('/api/admin/industrial-zones/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  await env.DB.prepare('UPDATE industrial_zones SET name=?, county=? WHERE id=?')
    .bind(b.name?.trim(), b.county, params.id).run();
  return json({ ok: true });
});
router.del('/api/admin/industrial-zones/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  await env.DB.prepare('DELETE FROM industrial_zones WHERE id=?').bind(params.id).run();
  return json({ ok: true });
});

// ------------------------------------------------------------------
// پیامک هدفمند از پنل مدیریت (به منتخب یا همهٔ ثبت‌نام‌کننده‌ها)
// چون حساب سرویس پیامک وجود ندارد، ارسال واقعی از طریق اپ پیامک خودِ گوشیِ
// مدیر انجام می‌شود (لینک sms:) — این endpoint فقط برای تاریخچه/سابقه ثبت می‌کند
// ------------------------------------------------------------------
router.post('/api/admin/sms/log', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  const company = await env.DB.prepare('SELECT id, phone FROM companies WHERE id=?').bind(b.companyId).first();
  if (!company) return error('شرکت یافت نشد', 404);
  await env.DB.prepare('INSERT INTO sms_log (company_id, phone, message, status) VALUES (?,?,?,?)')
    .bind(company.id, company.phone, (b.message || '').trim(), 'composed_on_device').run();
  return json({ ok: true }, 201);
});

router.get('/api/admin/sms/log', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare(`
    SELECT s.*, c.name AS company_name FROM sms_log s
    LEFT JOIN companies c ON c.id = s.company_id
    ORDER BY s.id DESC LIMIT 200
  `).all();
  return json(results);
});

router.get('/api/admin/companies', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare('SELECT * FROM companies ORDER BY created_at DESC').all();
  return json(results);
});

router.get('/api/admin/contact-messages', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC').all();
  return json(results);
});
router.put('/api/admin/contact-messages/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  await env.DB.prepare('UPDATE contact_messages SET status=? WHERE id=?').bind(b.status || 'خوانده‌شد', params.id).run();
  return json({ ok: true });
});
router.del('/api/admin/contact-messages/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  await env.DB.prepare('DELETE FROM contact_messages WHERE id=?').bind(params.id).run();
  return json({ ok: true });
});

router.get('/api/admin/rfqs', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare(
    `SELECT rfqs.*, offers.title as offer_title FROM rfqs JOIN offers ON offers.id = rfqs.offer_id ORDER BY rfqs.created_at DESC`
  ).all();
  return json(results);
});
router.put('/api/admin/companies/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  const cols = ['name', 'county', 'category', 'products', 'capacity', 'verified', 'active', 'presentation_status', 'latitude', 'longitude', 'industrial_zone'];
  const setCols = cols.filter(c => b[c] !== undefined);
  if (!setCols.length) return error('چیزی برای تغییر ارسال نشده');
  await env.DB.prepare(`UPDATE companies SET ${setCols.map(c => c + '=?').join(',')} WHERE id=?`)
    .bind(...setCols.map(c => b[c]), params.id).run();
  return json({ ok: true });
});

router.post('/api/admin/companies/:id/reset-password', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  if (!b.newPassword || b.newPassword.length < 4) return error('رمز جدید باید حداقل ۴ کاراکتر باشد');
  const pw = await hashPassword(b.newPassword);
  await env.DB.prepare('UPDATE companies SET password_hash=? WHERE id=?').bind(pw, params.id).run();
  return json({ ok: true });
});

router.get('/api/admin/pending-edits', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare(`SELECT * FROM pending_edits WHERE status='pending' ORDER BY created_at DESC`).all();
  return json(results);
});
router.put('/api/admin/pending-edits/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request); // { decision: 'approved' | 'rejected' }
  const edit = await env.DB.prepare('SELECT * FROM pending_edits WHERE id=?').bind(params.id).first();
  if (!edit) return error('یافت نشد', 404);
  if (b.decision === 'approved') {
    const changes = JSON.parse(edit.changes_json);
    const cols = Object.keys(changes);
    if (cols.length) {
      const table = { company: 'companies', offer: 'offers', service_request: 'service_requests' }[edit.entity_type] || 'offers';
      await env.DB.prepare(`UPDATE ${table} SET ${cols.map(c => c + '=?').join(',')} WHERE id=?`)
        .bind(...cols.map(c => changes[c]), edit.entity_id).run();
    }
  }
  await env.DB.prepare(`UPDATE pending_edits SET status=?, reviewed_at=datetime('now') WHERE id=?`)
    .bind(b.decision, params.id).run();
  return json({ ok: true });
});

router.get('/api/admin/requests', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare('SELECT * FROM purchase_requests ORDER BY created_at DESC').all();
  for (const r of results) {
    const { results: responses } = await env.DB.prepare('SELECT company_name, phone, created_at FROM request_responses WHERE request_id=?').bind(r.id).all();
    r.responses = responses;
  }
  return json(results);
});
router.del('/api/admin/requests/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  await env.DB.prepare('DELETE FROM request_responses WHERE request_id=?').bind(params.id).run();
  await env.DB.prepare('DELETE FROM purchase_requests WHERE id=?').bind(params.id).run();
  return json({ ok: true });
});

router.get('/api/admin/service-requests', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare('SELECT * FROM service_requests ORDER BY created_at DESC').all();
  return json(results);
});
router.put('/api/admin/service-requests/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  await env.DB.prepare('UPDATE service_requests SET status=? WHERE id=?').bind(b.status || 'باز', params.id).run();
  return json({ ok: true });
});
router.del('/api/admin/service-requests/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  await env.DB.prepare('DELETE FROM service_requests WHERE id=?').bind(params.id).run();
  return json({ ok: true });
});

// ------------------------------------------------------------------
// مدیریت: نظارت بر چت‌ها، گزارش‌های تخلف، تایید نظرات، لاگ تطبیق هوشمند
// ------------------------------------------------------------------
router.get('/api/admin/settings', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  return json(await getPlatformSettings(env));
});
router.put('/api/admin/settings', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  const fields = [], binds = [];
  if (typeof b.chat_enabled !== 'undefined') { fields.push('chat_enabled=?'); binds.push(b.chat_enabled ? 1 : 0); }
  if (typeof b.chat_auto_approve !== 'undefined') { fields.push('chat_auto_approve=?'); binds.push(b.chat_auto_approve ? 1 : 0); }
  if (!fields.length) return error('چیزی برای تغییر مشخص نشده');
  await env.DB.prepare(`UPDATE platform_settings SET ${fields.join(', ')}, updated_at=datetime('now') WHERE id=1`).bind(...binds).run();
  return json({ ok: true });
});
router.post('/api/admin/conversations/:id/approve', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const convo = await env.DB.prepare('SELECT * FROM conversations WHERE id=?').bind(params.id).first();
  if (!convo) return error('گفتگو یافت نشد', 404);
  await env.DB.prepare('UPDATE conversations SET approved=1 WHERE id=?').bind(params.id).run();
  const otherId = convo.company_a_id === convo.initiator_company_id ? convo.company_b_id : convo.company_a_id;
  await env.DB.prepare('INSERT INTO notifications (company_id, type, title, body, link) VALUES (?,?,?,?,?)')
    .bind(otherId, 'message', 'گفتگوی جدید', 'یک گفتگوی جدید برای شما تایید و باز شد', `#chat-${convo.id}`).run();
  return json({ ok: true });
});

router.get('/api/admin/conversations', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare(`
    SELECT c.*, ca.name AS company_a_name, cb.name AS company_b_name,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id) AS message_count,
      (SELECT COUNT(*) FROM message_reports mr WHERE mr.conversation_id=c.id AND mr.status='pending') AS pending_reports
    FROM conversations c
    JOIN companies ca ON ca.id=c.company_a_id
    JOIN companies cb ON cb.id=c.company_b_id
    ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
  `).all();
  return json(results);
});
router.get('/api/admin/conversations/:id/messages', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare(`
    SELECT m.*, c.name AS sender_name FROM messages m
    JOIN companies c ON c.id = m.sender_company_id
    WHERE m.conversation_id=? ORDER BY m.id ASC
  `).bind(params.id).all();
  return json(results);
});
router.post('/api/admin/conversations/:id/close', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  await env.DB.prepare(`UPDATE conversations SET status='closed_by_admin' WHERE id=?`).bind(params.id).run();
  return json({ ok: true });
});
router.post('/api/admin/conversations/:id/reopen', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  await env.DB.prepare(`UPDATE conversations SET status='open' WHERE id=?`).bind(params.id).run();
  return json({ ok: true });
});

router.get('/api/admin/message-reports', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare(`
    SELECT mr.*, m.body AS message_body, m.sender_company_id, c.name AS reported_by_name
    FROM message_reports mr
    JOIN messages m ON m.id = mr.message_id
    JOIN companies c ON c.id = mr.reported_by_company_id
    WHERE mr.status='pending' ORDER BY mr.created_at DESC
  `).all();
  return json(results);
});
router.post('/api/admin/message-reports/:id/resolve', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  await env.DB.prepare(`UPDATE message_reports SET status='reviewed' WHERE id=?`).bind(params.id).run();
  return json({ ok: true });
});

router.get('/api/admin/reviews', async ({ request, env, url }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const status = (url.searchParams.get('status') || 'pending');
  const { results } = await env.DB.prepare(`
    SELECT r.*, c.name AS company_name, rc.name AS reviewer_name
    FROM reviews r
    JOIN companies c ON c.id = r.company_id
    JOIN companies rc ON rc.id = r.reviewer_company_id
    WHERE r.status=? ORDER BY r.created_at DESC
  `).bind(status).all();
  return json(results);
});
router.post('/api/admin/reviews/:id/approve', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const rev = await env.DB.prepare('SELECT * FROM reviews WHERE id=?').bind(params.id).first();
  if (!rev) return error('نظر یافت نشد', 404);
  await env.DB.prepare(`UPDATE reviews SET status='approved' WHERE id=?`).bind(params.id).run();
  const agg = await env.DB.prepare(`SELECT AVG(rating) avg_r, COUNT(*) cnt FROM reviews WHERE company_id=? AND status='approved'`).bind(rev.company_id).first();
  await env.DB.prepare('UPDATE companies SET rating_avg=?, rating_count=? WHERE id=?')
    .bind(Math.round((agg.avg_r || 0) * 10) / 10, agg.cnt || 0, rev.company_id).run();
  return json({ ok: true });
});
router.post('/api/admin/reviews/:id/reject', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  await env.DB.prepare(`UPDATE reviews SET status='rejected' WHERE id=?`).bind(params.id).run();
  return json({ ok: true });
});

router.get('/api/admin/notifications-log', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare(`
    SELECT n.*, c.name AS company_name FROM notifications n
    JOIN companies c ON c.id = n.company_id
    WHERE n.type='match_request' ORDER BY n.created_at DESC LIMIT 200
  `).all();
  return json(results);
});

router.get('/api/admin/problems', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare('SELECT * FROM problems ORDER BY created_at DESC').all();
  return json(results);
});
router.del('/api/admin/problems/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  await env.DB.prepare('DELETE FROM problems WHERE id=?').bind(params.id).run();
  return json({ ok: true });
});

router.get('/api/admin/ads', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const { results } = await env.DB.prepare('SELECT * FROM ads ORDER BY created_at DESC').all();
  return json(results);
});
router.put('/api/admin/ads/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  const cols = ['status', 'start_date', 'end_date', 'title', 'body_text', 'image_url', 'video_embed_url', 'link_url'];
  const setCols = cols.filter(c => b[c] !== undefined);
  await env.DB.prepare(`UPDATE ads SET ${setCols.map(c => c + '=?').join(',')} WHERE id=?`)
    .bind(...setCols.map(c => b[c]), params.id).run();
  return json({ ok: true });
});
router.del('/api/admin/ads/:id', async ({ request, env, params }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  await env.DB.prepare('DELETE FROM ads WHERE id=?').bind(params.id).run();
  return json({ ok: true });
});

router.put('/api/admin/calculator-settings', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  await env.DB.prepare(`UPDATE calculator_settings SET base_notes=?, updated_at=datetime('now') WHERE id=1`)
    .bind(b.baseNotes || '').run();
  return json({ ok: true });
});

// آمار برای داشبورد پنل مدیریت
router.get('/api/admin/analytics', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const totalViews = await env.DB.prepare('SELECT COUNT(*) c FROM page_views').first();
  const { results: daily } = await env.DB.prepare(
    `SELECT date(created_at) as day, COUNT(*) as c FROM page_views GROUP BY day ORDER BY day DESC LIMIT 14`
  ).all();
  const { results: topPaths } = await env.DB.prepare(
    `SELECT path, COUNT(*) as c FROM page_views GROUP BY path ORDER BY c DESC LIMIT 10`
  ).all();
  const totalCompanies = await env.DB.prepare('SELECT COUNT(*) c FROM companies').first();
  const totalOffers = await env.DB.prepare('SELECT COUNT(*) c FROM offers').first();
  const totalRequests = await env.DB.prepare('SELECT COUNT(*) c FROM purchase_requests').first();
  return json({
    totalViews: totalViews.c, daily, topPaths,
    totals: { companies: totalCompanies.c, offers: totalOffers.c, requests: totalRequests.c },
  });
});

// ------------------------------------------------------------------
// ابزار تشخیصی: بررسی اینکه کدام متغیر محیطی واقعاً تنظیم شده (بدون افشای مقدار)
// ------------------------------------------------------------------
router.get('/api/admin/env-check', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  return json({
    GITHUB_TOKEN: !!env.GITHUB_TOKEN,
    GITHUB_OWNER: !!env.GITHUB_OWNER,
    GITHUB_UPLOADS_REPO: !!env.GITHUB_UPLOADS_REPO,
    GITHUB_BRANCH: !!env.GITHUB_BRANCH,
    JWT_SECRET: !!env.JWT_SECRET,
    SETUP_KEY: !!env.SETUP_KEY,
    GITHUB_OWNER_value: env.GITHUB_OWNER || null,
    GITHUB_UPLOADS_REPO_value: env.GITHUB_UPLOADS_REPO || null,
    GITHUB_BRANCH_value: env.GITHUB_BRANCH || null,
  });
});

// ------------------------------------------------------------------
// پشتیبان‌گیری / بازیابی / پاک‌سازی داده‌ها
// ------------------------------------------------------------------
const BACKUP_TABLES = ['provinces', 'counties', 'categories', 'companies', 'offers', 'purchase_requests',
  'request_responses', 'rfqs', 'service_requests', 'problems', 'ads', 'pending_edits', 'admin_files',
  'calculator_settings', 'contact_messages', 'industrial_zones', 'conversations', 'messages',
  'conversation_reads', 'message_reports', 'reviews', 'notifications', 'sms_log'];

router.get('/api/admin/backup', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const dump = { created_at: new Date().toISOString(), tables: {} };
  for (const t of BACKUP_TABLES) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${t}`).all();
    dump.tables[t] = results;
  }
  return json(dump);
});

router.post('/api/admin/restore', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  if (!b.tables) return error('فایل پشتیبان نامعتبر است');
  // ابتدا جدول‌ها را از انتهای زنجیره وابستگی به ابتدا پاک می‌کنیم (فرزند قبل از والد)
  for (const t of [...BACKUP_TABLES].reverse()) {
    if (Array.isArray(b.tables[t])) await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  // سپس از والد به فرزند دوباره پر می‌کنیم
  for (const t of BACKUP_TABLES) {
    const rows = b.tables[t];
    if (!Array.isArray(rows) || !rows.length) continue;
    for (const row of rows) {
      const cols = Object.keys(row);
      const placeholders = cols.map(() => '?').join(',');
      await env.DB.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${placeholders})`)
        .bind(...cols.map(c => row[c])).run();
    }
  }
  return json({ ok: true, message: 'بازیابی انجام شد.' });
});

router.post('/api/admin/wipe', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const b = await readJson(request);
  if (b.confirm !== 'پاک کن') return error('برای تایید، عبارت درخواست‌شده را دقیق ارسال کنید');
  const wipeTables = ['request_responses', 'rfqs', 'pending_edits', 'contact_messages', 'offers',
    'purchase_requests', 'service_requests', 'problems', 'ads', 'companies', 'page_views', 'login_attempts'];
  for (const t of wipeTables) {
    await env.DB.prepare(`DELETE FROM ${t}`).run();
  }
  return json({ ok: true, message: 'همه اطلاعات آزمایشی پاک شد.' });
});

// ------------------------------------------------------------------
// خلاصه اعلان‌ها برای پنل مدیریت (نشان قرمز روی تب‌ها)
// ------------------------------------------------------------------
router.get('/api/admin/notifications', async ({ request, env }) => {
  if (!(await requireAdmin(request, env))) return error('دسترسی غیرمجاز', 401);
  const pendingEdits = await env.DB.prepare(`SELECT COUNT(*) c FROM pending_edits WHERE status='pending'`).first();
  const unreadMessages = await env.DB.prepare(`SELECT COUNT(*) c FROM contact_messages WHERE status='خوانده‌نشده'`).first();
  const pendingAds = await env.DB.prepare(`SELECT COUNT(*) c FROM ads WHERE status='pending'`).first();
  const unverifiedCompanies = await env.DB.prepare(`SELECT COUNT(*) c FROM companies WHERE verified=0`).first();
  const pendingPresentations = await env.DB.prepare(`SELECT COUNT(*) c FROM companies WHERE presentation_status='pending'`).first();
  const pendingReviews = await env.DB.prepare(`SELECT COUNT(*) c FROM reviews WHERE status='pending'`).first();
  const pendingReports = await env.DB.prepare(`SELECT COUNT(*) c FROM message_reports WHERE status='pending'`).first();
  const pendingConversations = await env.DB.prepare(`SELECT COUNT(*) c FROM conversations WHERE approved=0`).first();
  return json({
    pendingEdits: pendingEdits.c, unreadMessages: unreadMessages.c, pendingAds: pendingAds.c,
    unverifiedCompanies: unverifiedCompanies.c, pendingPresentations: pendingPresentations.c,
    pendingReviews: pendingReviews.c, pendingReports: pendingReports.c, pendingConversations: pendingConversations.c,
    total: pendingEdits.c + unreadMessages.c + pendingAds.c + pendingPresentations.c + pendingReviews.c + pendingReports.c + pendingConversations.c,
  });
});

// اعلان‌های تازه برای پنل خود کاربر (چیزهای جدید از آخرین بازدید)
router.get('/api/company/notifications', async ({ request, env }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('نیاز به ورود', 401);
  const cid = auth.companyId;
  const latestRfq = await env.DB.prepare(
    `SELECT MAX(rfqs.created_at) as t FROM rfqs JOIN offers ON offers.id=rfqs.offer_id WHERE offers.company_id=?`
  ).bind(cid).first();
  const latestResponse = await env.DB.prepare(
    `SELECT MAX(rr.created_at) as t FROM request_responses rr JOIN purchase_requests pr ON pr.id=rr.request_id WHERE pr.company_id=?`
  ).bind(cid).first();
  return json({ latestRfqAt: latestRfq.t, latestResponseAt: latestResponse.t });
});
// چون R2 در دسترس نیست، فایل‌ها در یک ریپازیتوری جدا روی GitHub ذخیره
// و از طریق jsDelivr (CDN رایگان) سرو می‌شوند.
// ------------------------------------------------------------------
router.post('/api/upload', async ({ request, env }) => {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) return error('فرمت درخواست نامعتبر است');
  const form = await request.formData();
  const file = form.get('file');
  if (!file) return error('فایلی ارسال نشده');
  const maxBytes = 8 * 1024 * 1024; // ۸ مگابایت — با توجه به محدودیت GitHub Contents API
  if (file.size > maxBytes) return error('حجم فایل باید کمتر از ۸ مگابایت باشد. برای ویدیو، لینک آپارات/یوتیوب استفاده کنید.');
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase();
  const key = randomKey('uploads', ext);
  try {
    const result = await uploadToGithub(env, key, await file.arrayBuffer(), file.type);
    return json({ key, url: result.url, fallbackUrl: result.fallbackUrl }, 201);
  } catch (e) {
    return error(String(e && e.message || e), 502);
  }
});

export default {
  async fetch(request, env, ctx) {
    try {
      return await router.handle(request, env, ctx);
    } catch (e) {
      return json({ error: 'خطای داخلی سرور', detail: String(e && e.message || e) }, 500);
    }
  },
};
