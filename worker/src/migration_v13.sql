-- ===================================================================
-- migration_v13 — ماژول «دستیار اداری» (امور اداری واحدها)
--
-- ⭐ روش پیشنهادی (بدون SQL): پنل مدیریت ← تب «📨 امور اداری» ← دکمهٔ «ساخت جدول‌ها».
--    همان دکمه همین دستورها را اجرا می‌کند و اداره/خدمت/طرح نمونه هم می‌سازد.
--
-- روش دستی (فقط در صورت نیاز): در D1 Console هر دستور را «جداگانه» پیست و Execute کنید
-- (هرگز چند دستور را یک‌جا پیست نکنید؛ فقط اولی اجرا می‌شود).
-- همهٔ دستورها «IF NOT EXISTS» هستند و اجرای مجدد بی‌خطر است.
-- ===================================================================

-- (1/13)
CREATE TABLE IF NOT EXISTS corr_settings (key TEXT PRIMARY KEY, value TEXT);

-- (2/13)
CREATE TABLE IF NOT EXISTS corr_offices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'شهرستان',
  county TEXT, description TEXT, active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- (3/13)
CREATE TABLE IF NOT EXISTS corr_office_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, office_id INTEGER NOT NULL, username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, full_name TEXT, active INTEGER NOT NULL DEFAULT 1, last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- (4/13)
CREATE TABLE IF NOT EXISTS corr_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, price INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- (5/13)
CREATE TABLE IF NOT EXISTS corr_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT, duration_days INTEGER NOT NULL DEFAULT 30,
  price INTEGER NOT NULL DEFAULT 0, included_requests INTEGER NOT NULL DEFAULT 0, badge TEXT,
  active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- (6/13)
CREATE TABLE IF NOT EXISTS corr_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL, plan_id INTEGER, plan_title TEXT,
  amount INTEGER NOT NULL DEFAULT 0, included_requests INTEGER NOT NULL DEFAULT 0, requests_used INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', starts_at TEXT, ends_at TEXT, receipt_url TEXT, receipt_note TEXT, admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));

-- (7/13)
CREATE TABLE IF NOT EXISTS corr_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tracking_code TEXT NOT NULL UNIQUE, company_id INTEGER NOT NULL,
  office_id INTEGER, office_name TEXT, service_id INTEGER, service_title TEXT,
  subject TEXT NOT NULL, body TEXT, attachments_json TEXT NOT NULL DEFAULT '[]', needs_physical INTEGER NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'عادی', status TEXT NOT NULL DEFAULT 'ثبت شد',
  billing TEXT NOT NULL DEFAULT 'pay_per_request', fee INTEGER NOT NULL DEFAULT 0, payment_status TEXT NOT NULL DEFAULT 'unpaid',
  receipt_url TEXT, receipt_note TEXT, subscription_id INTEGER,
  referred_office_id INTEGER, referred_office_name TEXT, admin_note TEXT,
  unread_admin INTEGER NOT NULL DEFAULT 1, unread_company INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));

-- (8/13)
CREATE TABLE IF NOT EXISTS corr_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL, actor TEXT NOT NULL, actor_name TEXT,
  kind TEXT NOT NULL DEFAULT 'message', title TEXT, text TEXT, attachments_json TEXT NOT NULL DEFAULT '[]',
  visible_company INTEGER NOT NULL DEFAULT 1, visible_office INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- (9/13)
CREATE INDEX IF NOT EXISTS idx_corr_requests_company ON corr_requests(company_id);

-- (10/13)
CREATE INDEX IF NOT EXISTS idx_corr_requests_status ON corr_requests(status);

-- (11/13)
CREATE INDEX IF NOT EXISTS idx_corr_requests_ref ON corr_requests(referred_office_id);

-- (12/13)
CREATE INDEX IF NOT EXISTS idx_corr_events_req ON corr_events(request_id);

-- (13/13)
CREATE INDEX IF NOT EXISTS idx_corr_subs_company ON corr_subscriptions(company_id);
