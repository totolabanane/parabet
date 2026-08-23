-- Schéma de la base de données ParaBet, pour Postgres (Neon).
-- Pas besoin de CREATE DATABASE / USE : sur Neon, la base du projet existe déjà,
-- la chaîne de connexion (DATABASE_URL) pointe directement dessus.

CREATE TABLE IF NOT EXISTS accounts (
  id                SERIAL PRIMARY KEY,
  pseudo            VARCHAR(20) NOT NULL,
  pseudo_lower      VARCHAR(20) NOT NULL UNIQUE,
  password_hash     VARCHAR(255) NOT NULL,
  balance           INTEGER NOT NULL DEFAULT 500,
  is_admin          INTEGER NOT NULL DEFAULT 0,
  last_bonus_date   BIGINT DEFAULT NULL, -- timestamp epoch (ms) de la dernière réclamation du bonus quotidien
  referral_code     VARCHAR(12) UNIQUE,
  referred_by       INTEGER DEFAULT NULL,
  referral_earnings INTEGER NOT NULL DEFAULT 0,
  referral_bonus_referrer INTEGER NOT NULL DEFAULT 0,
  referral_bonus_referee  INTEGER NOT NULL DEFAULT 0,
  referral_validated_at   TIMESTAMP DEFAULT NULL,
  wagering_required INTEGER NOT NULL DEFAULT 0,
  wagering_progress INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (referred_by) REFERENCES accounts(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS markets (
  id           VARCHAR(40) PRIMARY KEY,
  category     VARCHAR(20) NOT NULL,
  title        VARCHAR(255) NOT NULL,
  yes_pct      INTEGER NOT NULL DEFAULT 50,
  volume       INTEGER NOT NULL DEFAULT 0,
  closes_label VARCHAR(60) DEFAULT 'Indéterminée',
  status       VARCHAR(10) NOT NULL DEFAULT 'open',
  resolution   VARCHAR(3) DEFAULT NULL,
  resolved_at  TIMESTAMP DEFAULT NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bets (
  id         SERIAL PRIMARY KEY,
  market_id  VARCHAR(40) NOT NULL,
  account_id INTEGER NOT NULL,
  side       VARCHAR(3) NOT NULL,
  amount     INTEGER NOT NULL,
  price      INTEGER NOT NULL,
  refunded   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS feed (
  id         SERIAL PRIMARY KEY,
  pseudo     VARCHAR(20) NOT NULL,
  side       VARCHAR(5) DEFAULT NULL,
  amount     INTEGER NOT NULL DEFAULT 0,
  title      VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS deposits (
  id              SERIAL PRIMARY KEY,
  account_id      INTEGER NOT NULL,
  amount          INTEGER NOT NULL,
  amount_usd      NUMERIC(12,2) DEFAULT NULL,
  screenshot_file VARCHAR(255) NOT NULL,
  status          VARCHAR(10) NOT NULL DEFAULT 'pending',
  reject_reason   TEXT DEFAULT NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at     TIMESTAMP DEFAULT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id               SERIAL PRIMARY KEY,
  account_id       INTEGER NOT NULL,
  amount           INTEGER NOT NULL,
  amount_usd       NUMERIC(12,2) DEFAULT NULL,
  tax_percent      NUMERIC(5,2) DEFAULT NULL,
  minecraft_pseudo VARCHAR(32) NOT NULL DEFAULT '',
  status           VARCHAR(10) NOT NULL DEFAULT 'pending',
  reject_reason    TEXT DEFAULT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at      TIMESTAMP DEFAULT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Paramètres généraux réglables depuis l'admin (taux $/💎, taxe de retrait,
-- pseudo à qui envoyer le /pay pour les dépôts...). Clé/valeur générique.
CREATE TABLE IF NOT EXISTS settings (
  key   VARCHAR(50) PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS casino_bets (
  id         SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL,
  game       VARCHAR(20) NOT NULL,
  bet        INTEGER NOT NULL,
  payout     INTEGER NOT NULL DEFAULT 0,
  result     VARCHAR(10) NOT NULL,
  detail     VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
);

-- Limites de mise par jeu de casino, réglables depuis l'admin (max_bet NULL = pas de plafond).
CREATE TABLE IF NOT EXISTS casino_limits (
  game    VARCHAR(20) PRIMARY KEY,
  min_bet INTEGER NOT NULL DEFAULT 10,
  max_bet INTEGER DEFAULT NULL
);

-- Offres du moment, configurées par le staff (1er dépôt doublé / parrainage
-- boosté), affichées en bandeau sur l'accueil tant qu'elles sont actives et
-- non expirées. Une seule offre par type est appliquée à la fois (la plus
-- récente, active et non expirée).
CREATE TABLE IF NOT EXISTS offers (
  id              SERIAL PRIMARY KEY,
  type            VARCHAR(20) NOT NULL,       -- 'deposit_boost' | 'referral_boost' | 'contest'
  title           VARCHAR(140) DEFAULT NULL,
  max_bonus       INTEGER DEFAULT NULL,       -- deposit_boost : bonus max en 💎 ; contest : lot en 💎 à gagner
  referrer_bonus  INTEGER DEFAULT NULL,       -- referral_boost : bonus parrain en 💎
  referee_bonus   INTEGER DEFAULT NULL,       -- referral_boost : bonus filleul en 💎
  min_wager       INTEGER DEFAULT NULL,       -- contest : mise minimum requise en 💎 pour participer (NULL = pas de condition)
  min_wager_since TIMESTAMP DEFAULT NULL,     -- contest : date à partir de laquelle les mises comptent
  ends_at         TIMESTAMP DEFAULT NULL,     -- NULL = offre permanente
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_offers_type_active ON offers(type, active);

-- Participations aux concours : un joueur "participe" en cliquant sur le
-- bouton dédié (au lieu d'être automatiquement inscrit). Une seule
-- participation par joueur et par concours.
CREATE TABLE IF NOT EXISTS contest_entries (
  id         SERIAL PRIMARY KEY,
  offer_id   INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  UNIQUE (offer_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_contest_entries_offer ON contest_entries(offer_id);

-- Index utiles
CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id);
CREATE INDEX IF NOT EXISTS idx_bets_account ON bets(account_id);
CREATE INDEX IF NOT EXISTS idx_casino_bets_account ON casino_bets(account_id);
CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposits(status);
CREATE INDEX IF NOT EXISTS idx_deposits_account ON deposits(account_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
CREATE INDEX IF NOT EXISTS idx_withdrawals_account ON withdrawals(account_id);
CREATE INDEX IF NOT EXISTS idx_accounts_referred_by ON accounts(referred_by);
