-- ===================================================================
-- migration_v2 — سیستم یکپارچه ثبت‌نام با نقش + مالکیت درخواست‌ها + عکس + پیام پشتیبانی
-- این فایل را در D1 Console اجرا کنید (بعد از schema.sql اصلی)
-- ===================================================================

-- نقش حساب: producer | service | buyer | other
ALTER TABLE companies ADD COLUMN role TEXT NOT NULL DEFAULT 'other';
-- آیا پروفایل تکمیل شده یا فقط ثبت‌نام اولیه (۴ فیلدی) انجام شده
ALTER TABLE companies ADD COLUMN profile_completed INTEGER NOT NULL DEFAULT 0;

-- عکس محصول
ALTER TABLE offers ADD COLUMN image_url TEXT;

-- مالکیت درخواست خرید و درخواست خدمات به حساب کاربری (برای نمایش در پنل خودشان)
ALTER TABLE purchase_requests ADD COLUMN company_id INTEGER REFERENCES companies(id);
ALTER TABLE service_requests ADD COLUMN company_id INTEGER REFERENCES companies(id);

-- ثبت درخواست‌کننده استعلام (برای نمایش «استعلام‌های ارسالی من» در پنل)
ALTER TABLE rfqs ADD COLUMN company_id INTEGER REFERENCES companies(id);

-- پیام‌های تماس/پیشنهاد/پشتیبانی
CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id),
  name TEXT,
  phone TEXT,
  subject TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'خوانده‌نشده',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
