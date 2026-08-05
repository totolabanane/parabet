-- Schéma SQLite de la base de données ParaBet
-- Créé automatiquement au démarrage par db.js (pas besoin de le lancer à la main)

CREATE TABLE IF NOT EXISTS accounts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  pseudo            TEXT NOT NULL,
  pseudo_lower      TEXT NOT NULL UNIQUE,
  password_hash     TEXT NOT NULL,
  balance           INTEGER NOT NULL DEFAULT 500,
  is_admin          INTEGER NOT NULL DEFAULT 0,
  last_bonus_date   TEXT DEFAULT NULL,
  referral_code     TEXT UNIQUE,
  referred_by       INTEGER DEFAULT NULL,
  referral_earnings INTEGER NOT NULL DEFAULT 0,
  wagering_required INTEGER NOT NULL DEFAULT 0,
  wagering_progress INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (referred_by) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS markets (
  id           TEXT PRIMARY KEY,
  category     TEXT NOT NULL,
  title        TEXT NOT NULL,
  yes_pct      INTEGER NOT NULL DEFAULT 50,
  volume       INTEGER NOT NULL DEFAULT 0,
  closes_label TEXT DEFAULT 'Indéterminée',
  status       TEXT NOT NULL DEFAULT 'open',
  resolution   TEXT DEFAULT NULL,
  resolved_at  TEXT DEFAULT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  market_id  TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  side       TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  price      INTEGER NOT NULL,
  refunded   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS feed (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pseudo     TEXT NOT NULL,
  side       TEXT DEFAULT NULL,
  amount     INTEGER NOT NULL DEFAULT 0,
  title      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deposits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      INTEGER NOT NULL,
  amount          INTEGER NOT NULL,
  screenshot_file TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at     TEXT DEFAULT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   INTEGER NOT NULL,
  amount       INTEGER NOT NULL,
  minecraft_pseudo TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at  TEXT DEFAULT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS casino_bets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  game       TEXT NOT NULL,               -- 'blackjack' | 'mines' | 'flip'
  bet        INTEGER NOT NULL,
  payout     INTEGER NOT NULL DEFAULT 0,
  result     TEXT NOT NULL,               -- 'win' | 'lose' | 'push' | 'cashout'
  detail     TEXT DEFAULT NULL,           -- petit résumé lisible pour l'admin
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id);
CREATE INDEX IF NOT EXISTS idx_bets_account ON bets(account_id);
CREATE INDEX IF NOT EXISTS idx_casino_bets_account ON casino_bets(account_id);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
CREATE INDEX IF NOT EXISTS idx_deposits_account ON deposits(account_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_account ON withdrawals(account_id);
-- NB: l'index sur accounts(referred_by) est créé dans db.js, après la
-- migration qui ajoute la colonne (une base déjà existante n'a pas encore
-- cette colonne au moment où ce fichier est exécuté).
