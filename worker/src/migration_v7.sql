-- ===================================================================
-- migration_v7 — چت پشتیبانی (گفتگوی هر شرکت با مدیریت پلتفرم)
-- در Cloudflare D1 Console اجرا کنید — هر بلوک را جدا Execute کنید
-- ===================================================================

-- ۱) یک تاپیک پشتیبانی برای هر شرکت (حداکثر یکی، مثل تیکت مداوم)
CREATE TABLE IF NOT EXISTS support_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL UNIQUE REFERENCES companies(id),
  status TEXT NOT NULL DEFAULT 'open',
  last_message_at TEXT,
  last_read_by_company_at TEXT,
  last_read_by_admin_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ۲) پیام‌های همان تاپیک
CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES support_threads(id),
  sender_type TEXT NOT NULL, -- 'company' یا 'admin'
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
