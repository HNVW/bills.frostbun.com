-- Identity: one row per Access email.
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- A group, its membership, and its shareable invite link.
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  invite_token TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS groups_invite ON groups (invite_token);

CREATE TABLE IF NOT EXISTS members (
  group_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, email)
);

CREATE INDEX IF NOT EXISTS members_email ON members (email);

-- Money entries. `participants` and `images` are JSON arrays.
CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL CHECK (amount > 0),
  paid_by TEXT NOT NULL,
  participants TEXT NOT NULL,
  images TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS bills_group ON bills (group_id, created_at);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  from_email TEXT NOT NULL,
  to_email TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  images TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_group ON payments (group_id, created_at);

-- R2 keys awaiting a bill/payment; the daily sweep deletes unreferenced ones.
CREATE TABLE IF NOT EXISTS uploads (
  key TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Web Push subscriptions, one row per browser per user.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS push_subscriptions_email ON push_subscriptions (email);
