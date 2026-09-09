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
router.get('/api/companies', async ({ env, url }) => {
  const q = url.searchParams.get('q') || '';
  const role = url.searchParams.get('role') || '';
  let sql = `SELECT id, name, county, province, category, products, capacity, role, verified, active, presentation_url, presentation_type, presentation_status
             FROM companies WHERE active=1`;
  const binds = [];
  if (q) { sql += ` AND name LIKE ?`; binds.push(`%${q}%`); }
  if (role) { sql += ` AND role = ?`; binds.push(role); }
  sql += ` ORDER BY verified DESC, created_at DESC LIMIT 100`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return json(results);
});

router.get('/api/companies/:id', async ({ env, params }) => {
  const c = await env.DB.prepare('SELECT * FROM companies WHERE id=?').bind(params.id).first();
  if (!c) return error('یافت نشد', 404);
  await env.DB.prepare('UPDATE companies SET profile_views = profile_views + 1 WHERE id=?').bind(params.id).run();
  delete c.password_hash;
  return json(c);
});

// ------------------------------------------------------------------
// عمومی: عرضه‌ها
// ------------------------------------------------------------------
router.get('/api/offers', async ({ env, url }) => {
  const q = url.searchParams.get('q') || '';
  const county = url.searchParams.get('county') || '';
  const category = url.searchParams.get('category') || '';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
  let sql = `SELECT o.*, c.name as company_name, c.verified as company_verified
             FROM offers o JOIN companies c ON c.id = o.company_id
             WHERE o.active=1`;
  const binds = [];
  if (q) { sql += ` AND (o.title LIKE ? OR c.name LIKE ?)`; binds.push(`%${q}%`, `%${q}%`); }
  if (county) { sql += ` AND o.county = ?`; binds.push(county); }
  if (category) { sql += ` AND o.category = ?`; binds.push(category); }
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
  const res = await env.DB.prepare(
    `INSERT INTO rfqs (offer_id, company_id, company_name, person_name, phone, quantity, message) VALUES (?,?,?,?,?,?,?)`
  ).bind(b.offerId, company.id, company.name, company.name, company.phone, b.quantity || '', b.message || '').run();
  return json({ id: res.meta.last_row_id }, 201);
});

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
  return json({ id: res.meta.last_row_id }, 201);
});

router.post('/api/requests/:id/respond', async ({ request, env, params }) => {
  const auth = await requireCompany(request, env);
  if (!auth) return error('برای اعلام آمادگی ابتدا باید ثبت‌نام یا وارد شوید', 401);
  const company = await env.DB.prepare('SELECT * FROM companies WHERE id=?').bind(auth.companyId).first();
  if (!company) return error('حساب یافت نشد', 404);
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
  return json({ id: res.meta.last_row_id }, 201);
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
    company: pick(company, ['id', 'name', 'phone', 'role', 'verified', 'active', 'profile_views', 'presentation_status', 'profile_completed', 'county', 'category', 'products', 'capacity', 'latitude', 'longitude', 'industrial_zone']),
    stats: { offers: offersCount.c, rfqs: rfqCount.c, responses: respCount.c, profileViews: company.profile_views, myRequests: myRequestsCount.c, myServices: myServiceCount.c },
    myOffers, myRequests, myServices, myRfqsSent, rfqsReceived, monthlyViews,
  });
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
  'calculator_settings', 'contact_messages'];

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
  return json({
    pendingEdits: pendingEdits.c, unreadMessages: unreadMessages.c, pendingAds: pendingAds.c,
    unverifiedCompanies: unverifiedCompanies.c, pendingPresentations: pendingPresentations.c,
    total: pendingEdits.c + unreadMessages.c + pendingAds.c + pendingPresentations.c,
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
