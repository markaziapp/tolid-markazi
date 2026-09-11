-- ===================================================================
-- migration_v4 — چت داخلی، امتیاز/نظر، اعلان‌های تطبیق هوشمند
-- در Cloudflare D1 Console اجرا کنید — هر بلوک را جدا، یکی‌یکی، Execute کنید
-- (طبق تجربهٔ قبلی: چند دستور با هم در یک بار اجرا نمی‌شود)
-- ===================================================================

-- ۱) گفتگوها (هر گفتگو بین دقیقاً دو شرکت)
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_a_id INTEGER NOT NULL REFERENCES companies(id),
  company_b_id INTEGER NOT NULL REFERENCES companies(id),
  related_type TEXT,
  related_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  last_message_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ۲) پیام‌ها
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  sender_company_id INTEGER NOT NULL REFERENCES companies(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ۳) نشانگر آخرین‌بار خواندن هر گفتگو توسط هرکدام از دو طرف (برای شمارش نخوانده‌ها)
CREATE TABLE IF NOT EXISTS conversation_reads (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  last_read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (conversation_id, company_id)
);

-- ۴) گزارش تخلف پیام (برای بررسی مدیر)
CREATE TABLE IF NOT EXISTS message_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  reported_by_company_id INTEGER NOT NULL REFERENCES companies(id),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ۵) امتیاز و نظر بعد از معامله (نیازمند تایید مدیر قبل از نمایش عمومی)
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  reviewer_company_id INTEGER NOT NULL REFERENCES companies(id),
  rating INTEGER NOT NULL,
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ۶) ستون‌های خلاصهٔ اعتبار روی خودِ شرکت (برای نمایش سریع نشان‌ها بدون شمارش هر بار)
ALTER TABLE companies ADD COLUMN rating_avg REAL NOT NULL DEFAULT 0;

-- ۷
ALTER TABLE companies ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0;

-- ۸
ALTER TABLE companies ADD COLUMN deals_count INTEGER NOT NULL DEFAULT 0;

-- ۹) اعلان‌های داخل‌برنامه‌ای (پایهٔ تطبیق هوشمند + اعلان پیام جدید)
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
