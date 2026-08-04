// db.js — base de données SQLite toute simple (1 fichier, zéro serveur à installer)
// Utilise le module natif node:sqlite (intégré à Node.js 22+, aucune compilation,
// aucune dépendance npm à installer). Expose la même API minimale (query / getConnection)
// que l'ancien pool mysql2, donc le reste de server.js n'a presque rien à changer.

const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "parabet.db");

const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

// Crée les tables si elles n'existent pas encore (premier lancement)
const schema = fs.readFileSync(path.join(__dirname, "schema.sqlite.sql"), "utf8");
db.exec(schema);

// Migration douce : si la base existait déjà avant l'ajout du parrainage,
// les nouvelles colonnes ne sont pas créées par le schema ci-dessus
// (CREATE TABLE IF NOT EXISTS ne modifie pas une table existante), donc on
// les ajoute ici à la main. Chaque ALTER TABLE est ignoré s'il a déjà été
// appliqué (SQLite renvoie une erreur "duplicate column name" qu'on avale).
for (const stmt of [
  "ALTER TABLE accounts ADD COLUMN referral_code TEXT",
  "ALTER TABLE accounts ADD COLUMN referred_by INTEGER",
  "ALTER TABLE accounts ADD COLUMN referral_earnings INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE withdrawals ADD COLUMN minecraft_pseudo TEXT NOT NULL DEFAULT ''",
]) {
  try { db.exec(stmt); } catch (e) { /* colonne déjà présente, on ignore */ }
}
try {
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_referral_code ON accounts(referral_code)");
} catch (e) { /* ignore */ }
try {
  db.exec("CREATE INDEX IF NOT EXISTS idx_accounts_referred_by ON accounts(referred_by)");
} catch (e) { /* ignore */ }

/* ---------- petites adaptations de syntaxe MySQL -> SQLite ---------- */

function translate(sql) {
  return sql
    .replace(/\bNOW\(\)/gi, "datetime('now')")
    .replace(/\bCURDATE\(\)/gi, "date('now')")
    .replace(/\s+FOR UPDATE\b/gi, "");
}

function isSelect(sql) {
  return /^\s*SELECT/i.test(sql);
}

/* ---------- API compatible avec mysql2/promise (sous-ensemble utilisé) ---------- */

async function query(sql, params = []) {
  const translated = translate(sql);
  const stmt = db.prepare(translated);
  if (isSelect(translated)) {
    return [stmt.all(...params)];
  }
  const info = stmt.run(...params);
  return [{ insertId: info.lastInsertRowid, affectedRows: info.changes }];
}

async function getConnection() {
  return {
    query,
    beginTransaction: async () => db.exec("BEGIN"),
    commit: async () => db.exec("COMMIT"),
    rollback: async () => {
      try {
        db.exec("ROLLBACK");
      } catch (e) {
        // pas de transaction en cours, on ignore
      }
    },
    release: () => {},
  };
}

module.exports = { query, getConnection };
