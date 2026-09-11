-- ===================================================================
-- migration_v5 — دسته‌بندی‌های جامع محصول + تنظیمات چت پلتفرم
-- در Cloudflare D1 Console اجرا کنید — هر بلوک را جدا، یکی‌یکی، Execute کنید
-- ===================================================================

-- ۱) دسته‌بندی جامع محصولات/صنایع رایج (اگر موردی از قبل با همین اسم باشد، تکراری اضافه نمی‌شود)
INSERT OR IGNORE INTO categories (name) VALUES ('فلزات و آهن‌آلات');
INSERT OR IGNORE INTO categories (name) VALUES ('فولاد و ذوب‌آهن');
INSERT OR IGNORE INTO categories (name) VALUES ('ماشین‌آلات صنعتی');
INSERT OR IGNORE INTO categories (name) VALUES ('قطعات خودرو');
INSERT OR IGNORE INTO categories (name) VALUES ('لوازم خانگی');
INSERT OR IGNORE INTO categories (name) VALUES ('پتروشیمی و شیمیایی');
INSERT OR IGNORE INTO categories (name) VALUES ('پلاستیک و پلیمر');
INSERT OR IGNORE INTO categories (name) VALUES ('نساجی و پوشاک');
INSERT OR IGNORE INTO categories (name) VALUES ('چرم و کفش');
INSERT OR IGNORE INTO categories (name) VALUES ('مواد غذایی و کشاورزی');
INSERT OR IGNORE INTO categories (name) VALUES ('لبنیات');
INSERT OR IGNORE INTO categories (name) VALUES ('دام و طیور');
INSERT OR IGNORE INTO categories (name) VALUES ('کاشی و سرامیک');
INSERT OR IGNORE INTO categories (name) VALUES ('سیمان و مصالح ساختمانی');
INSERT OR IGNORE INTO categories (name) VALUES ('چوب و مبلمان');
INSERT OR IGNORE INTO categories (name) VALUES ('کاغذ و بسته‌بندی');
INSERT OR IGNORE INTO categories (name) VALUES ('شیشه و بلور');
INSERT OR IGNORE INTO categories (name) VALUES ('برق و الکترونیک');
INSERT OR IGNORE INTO categories (name) VALUES ('دارو و تجهیزات پزشکی');
INSERT OR IGNORE INTO categories (name) VALUES ('معدن و مواد معدنی');
INSERT OR IGNORE INTO categories (name) VALUES ('صنایع دستی');
INSERT OR IGNORE INTO categories (name) VALUES ('خدمات فنی و مهندسی');
INSERT OR IGNORE INTO categories (name) VALUES ('حمل و نقل و لجستیک');
INSERT OR IGNORE INTO categories (name) VALUES ('سایر');

-- ۲) تنظیمات سراسری پلتفرم (فعلاً فقط برای چت داخلی)
CREATE TABLE IF NOT EXISTS platform_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  chat_enabled INTEGER NOT NULL DEFAULT 1,
  chat_auto_approve INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ۳
INSERT OR IGNORE INTO platform_settings (id) VALUES (1);

-- ۴) مشخص می‌کند چه کسی گفتگو را شروع کرده (برای تایید یک‌طرفه تا وقتی مدیر تایید کند)
ALTER TABLE conversations ADD COLUMN initiator_company_id INTEGER;

-- ۵) آیا این گفتگو تایید شده و طرف مقابل هم می‌تواند ببیندش؟
ALTER TABLE conversations ADD COLUMN approved INTEGER NOT NULL DEFAULT 1;
