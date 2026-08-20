-- ===================================================================
-- بازار صنعتی استان مرکزی — اسکیمای پایگاه‌داده (Cloudflare D1 / SQLite)
-- ===================================================================

-- استان‌ها و شهرستان‌ها (قابل افزودن از پنل مدیریت)
CREATE TABLE IF NOT EXISTS provinces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS counties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  province_id INTEGER NOT NULL REFERENCES provinces(id)
);

-- دسته‌بندی محصولات/خدمات (قابل افزودن از پنل مدیریت)
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

-- مدیران سیستم (ورود به پنل مخفی)
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- محدودیت تلاش ورود (ضد حدس‌زنی رمز پنل مخفی)
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,               -- 'admin' یا 'company'
  identifier TEXT NOT NULL,          -- username یا company_id
  ip TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- واحدهای تولیدی / شرکت‌ها
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  password_hash TEXT,                -- برای ورود کارخانه به پنل خودش
  province TEXT NOT NULL DEFAULT 'مرکزی',
  county TEXT NOT NULL,
  category TEXT,
  products TEXT,
  capacity TEXT,
  logo_url TEXT,
  license_url TEXT,
  presentation_url TEXT,             -- فایل/ویدیوی پرزنت کارخانه
  presentation_type TEXT,            -- 'file' | 'video_link'
  presentation_status TEXT NOT NULL DEFAULT 'none', -- none|pending|approved|rejected
  verified INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  profile_views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- عرضه‌ها / آگهی محصول
CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  category TEXT,
  specs_json TEXT DEFAULT '{}',
  price TEXT,
  unit TEXT,
  moq TEXT,
  payment TEXT,
  province TEXT NOT NULL DEFAULT 'مرکزی',
  county TEXT,
  location TEXT,
  description TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  featured INTEGER NOT NULL DEFAULT 0,       -- ستاره‌دار
  featured_approved INTEGER NOT NULL DEFAULT 0, -- تایید مدیر برای نمایش ستاره
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- درخواست‌های خرید کالا
CREATE TABLE IF NOT EXISTS purchase_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product TEXT NOT NULL,
  specs TEXT,
  quantity TEXT,
  unit TEXT,
  province TEXT NOT NULL DEFAULT 'مرکزی',
  county TEXT,
  deadline TEXT,
  price_range TEXT,
  payment TEXT,
  description TEXT,
  company TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'معمولی',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- پاسخ تأمین‌کنندگان به درخواست خرید ("من می‌توانم تأمین کنم")
CREATE TABLE IF NOT EXISTS request_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL REFERENCES purchase_requests(id),
  company_id INTEGER REFERENCES companies(id),
  company_name TEXT,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- درخواست استعلام قیمت (RFQ) روی یک عرضه خاص
CREATE TABLE IF NOT EXISTS rfqs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id INTEGER NOT NULL REFERENCES offers(id),
  company_name TEXT,
  person_name TEXT,
  phone TEXT NOT NULL,
  quantity TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'جدید',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- درخواست خدمات تخصصی/نیروی انسانی (حسابدار، مدیر تولید و ...)
CREATE TABLE IF NOT EXISTS service_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role_title TEXT NOT NULL,          -- مثلاً "حسابدار صنعتی"
  service_category TEXT,             -- نیروی انسانی | خدمات فنی | مشاوره | ...
  description TEXT,
  province TEXT NOT NULL DEFAULT 'مرکزی',
  county TEXT,
  company TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT NOT NULL,
  urgency TEXT NOT NULL DEFAULT 'معمولی',
  status TEXT NOT NULL DEFAULT 'باز',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- مشکلات صنعتی (تعمیر، قطعه، پیمانکاری و ...)
CREATE TABLE IF NOT EXISTS problems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT,
  province TEXT NOT NULL DEFAULT 'مرکزی',
  county TEXT,
  urgency TEXT NOT NULL DEFAULT 'معمولی',
  company TEXT,
  phone TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- تبلیغات صفحه اصلی (متن / عکس / ویدیو)
CREATE TABLE IF NOT EXISTS ads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_type TEXT NOT NULL,             -- text | image | video
  title TEXT,
  body_text TEXT,
  image_url TEXT,
  video_embed_url TEXT,              -- لینک آپارات/یوتیوب
  link_url TEXT,
  advertiser_name TEXT,
  advertiser_phone TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
  start_date TEXT,
  end_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ویرایش‌های در انتظار تایید (وقتی کارخانه از پنل خودش چیزی را تغییر می‌دهد)
CREATE TABLE IF NOT EXISTS pending_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,         -- company | offer
  entity_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  changes_json TEXT NOT NULL,        -- {"field": "newValue", ...}
  status TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);

-- فایل‌های مفید بارگذاری‌شده توسط مدیر (نمونه قرارداد، لینک و ...)
CREATE TABLE IF NOT EXISTS admin_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  file_url TEXT,                     -- آدرس فایل در R2، یا یک لینک خارجی
  file_type TEXT,                    -- pdf | docx | link | ...
  is_locked INTEGER NOT NULL DEFAULT 0, -- ۰ = رایگان، ۱ = نیازمند خرید
  price INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- تنظیمات ابزار محاسبه بهای تمام‌شده (قیمت‌های پایه قابل‌ویرایش توسط مدیر)
CREATE TABLE IF NOT EXISTS calculator_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  base_notes TEXT DEFAULT 'می‌توانید نرخ‌های پایه را برای راهنمایی کاربران این‌جا ثبت کنید (اختیاری).',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- شمارنده بازدید صفحات (آمار داخلی سبک، جایگزین/مکمل Cloudflare Web Analytics)
CREATE TABLE IF NOT EXISTS page_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  ref TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ================= داده‌های اولیه =================
INSERT OR IGNORE INTO provinces (name) VALUES ('مرکزی');

INSERT OR IGNORE INTO counties (name, province_id) VALUES
 ('اراک', 1), ('ساوه', 1), ('خمین', 1), ('محلات', 1), ('دلیجان', 1),
 ('شازند', 1), ('تفرش', 1), ('آشتیان', 1), ('خنداب', 1), ('فراهان', 1),
 ('کمیجان', 1), ('زرندیه', 1);

INSERT OR IGNORE INTO categories (name) VALUES
 ('فولاد و آهن'), ('آلومینیوم'), ('مس'), ('سیمان'), ('پتروشیمی'),
 ('پلیمر'), ('خدمات فنی'), ('سایر');

INSERT OR IGNORE INTO calculator_settings (id) VALUES (1);
