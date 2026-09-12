-- ===================================================================
-- migration_v6 — ارسال پیامک هدفمند از پنل مدیریت
-- در Cloudflare D1 Console اجرا کنید (یک بلوک، جدا)
-- ===================================================================

CREATE TABLE IF NOT EXISTS sms_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id),
  phone TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
