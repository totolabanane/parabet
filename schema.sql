-- Schéma de la base de données ParaBet (séparée de la base Vault/Essentials)
-- Utilisation : mysql -u root -p < schema.sql

CREATE DATABASE IF NOT EXISTS parabet CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE parabet;

CREATE TABLE IF NOT EXISTS accounts (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  pseudo            VARCHAR(20) NOT NULL,
  pseudo_lower      VARCHAR(20) NOT NULL UNIQUE,
  password_hash     VARCHAR(255) NOT NULL,
  balance           INT NOT NULL DEFAULT 500,
  is_admin          TINYINT(1) NOT NULL DEFAULT 0,
  last_bonus_date   DATE DEFAULT NULL,
  referral_code     VARCHAR(12) UNIQUE,
  referred_by       INT DEFAULT NULL,
  referral_earnings INT NOT NULL DEFAULT 0,
  wagering_required INT NOT NULL DEFAULT 0,
  wagering_progress INT NOT NULL DEFAULT 0,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (referred_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS markets (
  id           VARCHAR(40) PRIMARY KEY,
  category     VARCHAR(20) NOT NULL,
  title        VARCHAR(255) NOT NULL,
  yes_pct      INT NOT NULL DEFAULT 50,
  volume       INT NOT NULL DEFAULT 0,
  closes_label VARCHAR(60) DEFAULT 'Indéterminée',
  status       ENUM('open','locked','resolved') NOT NULL DEFAULT 'open',
  resolution   ENUM('yes','no') DEFAULT NULL,
  resolved_at  DATETIME DEFAULT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS bets (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  market_id  VARCHAR(40) NOT NULL,
  account_id INT NOT NULL,
  side       ENUM('yes','no') NOT NULL,
  amount     INT NOT NULL,
  price      INT NOT NULL,
  refunded   TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (market_id) REFERENCES markets(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS feed (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  pseudo     VARCHAR(20) NOT NULL,
  side       VARCHAR(5) DEFAULT NULL,
  amount     INT NOT NULL DEFAULT 0,
  title      VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS deposits (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  account_id      INT NOT NULL,
  amount          INT NOT NULL,
  screenshot_file VARCHAR(255) NOT NULL,
  status          ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at     DATETIME DEFAULT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS withdrawals (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  account_id   INT NOT NULL,
  amount       INT NOT NULL,
  minecraft_pseudo VARCHAR(32) NOT NULL DEFAULT '',
  status       ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at  DATETIME DEFAULT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS casino_bets (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  account_id INT NOT NULL,
  game       VARCHAR(20) NOT NULL,
  bet        INT NOT NULL,
  payout     INT NOT NULL DEFAULT 0,
  result     VARCHAR(10) NOT NULL,
  detail     VARCHAR(255) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Index utiles
CREATE INDEX idx_bets_market ON bets(market_id);
CREATE INDEX idx_bets_account ON bets(account_id);
CREATE INDEX idx_casino_bets_account ON casino_bets(account_id);
CREATE INDEX idx_deposits_status ON deposits(status);
CREATE INDEX idx_deposits_account ON deposits(account_id);
CREATE INDEX idx_withdrawals_status ON withdrawals(status);
CREATE INDEX idx_withdrawals_account ON withdrawals(account_id);
CREATE INDEX idx_accounts_referred_by ON accounts(referred_by);
