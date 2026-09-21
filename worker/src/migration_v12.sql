ALTER TABLE problems ADD COLUMN company_id INTEGER;

ALTER TABLE problems ADD COLUMN status TEXT NOT NULL DEFAULT 'ثبت شده';

ALTER TABLE problems ADD COLUMN visit_date TEXT;

CREATE TABLE IF NOT EXISTS resolutions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  problem_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  responsible_org TEXT,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'در حال اجرا',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
