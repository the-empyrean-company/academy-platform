CREATE TABLE IF NOT EXISTS learners (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT UNIQUE NOT NULL,
  name           TEXT,
  role           TEXT,
  company        TEXT,
  company_domain TEXT,
  session_token              TEXT,
  created_at                 TEXT DEFAULT (datetime('now')),
  last_active_at             TEXT DEFAULT (datetime('now')),
  notifications_last_read_at TEXT,
  password_hash              TEXT,
  password_salt              TEXT
);

CREATE TABLE IF NOT EXISTS lesson_progress (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  learner_id   INTEGER NOT NULL REFERENCES learners(id),
  lesson_id    TEXT NOT NULL,
  module_id    TEXT NOT NULL,
  started_at   TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE(learner_id, lesson_id)
);

CREATE TABLE IF NOT EXISTS badges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  learner_id INTEGER NOT NULL REFERENCES learners(id),
  badge_id   TEXT NOT NULL,
  earned_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(learner_id, badge_id)
);

CREATE TABLE IF NOT EXISTS block_progress (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  learner_id   INTEGER NOT NULL REFERENCES learners(id),
  lesson_id    TEXT NOT NULL,
  block_idx    INTEGER NOT NULL,
  completed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(learner_id, lesson_id, block_idx)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_learners_token          ON learners(session_token);
CREATE INDEX IF NOT EXISTS idx_lesson_progress_learner ON lesson_progress(learner_id);
CREATE INDEX IF NOT EXISTS idx_lesson_progress_module  ON lesson_progress(module_id);
CREATE INDEX IF NOT EXISTS idx_learners_domain         ON learners(company_domain);
CREATE INDEX IF NOT EXISTS idx_badges_learner          ON badges(learner_id);
CREATE INDEX IF NOT EXISTS idx_block_progress_learner  ON block_progress(learner_id);
