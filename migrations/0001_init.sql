-- Identity: one row per Access email. `qr` is the R2 key of the payment QR (`qrs/<email>`).
CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  qr TEXT
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

-- Money entries. `weights` is a JSON object of email → weight, and its keys are the participants in split
-- order; `image` is the entry's R2 key (`<kind>/<group-id>/<id>`).
CREATE TABLE IF NOT EXISTS bills (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL CHECK (amount > 0),
  paid_by TEXT NOT NULL,
  weights TEXT NOT NULL,
  image TEXT,
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
  image TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS payments_group ON payments (group_id, created_at);

-- Web Push subscriptions, one row per browser per user.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS push_subscriptions_email ON push_subscriptions (email);
