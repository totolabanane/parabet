// db.js — Postgres (Neon) via le module "pg"
// Expose la même API minimale (query / getConnection) qu'avant (SQLite / mysql2),
// donc server.js n'a besoin d'aucune modification.

const fs = require("fs");
const path = require("path");
const { Pool, types } = require("pg");

// Le driver pg convertit par défaut TIMESTAMP/DATE en objets Date JS.
// Le reste du code (server.js) a été écrit pour SQLite, qui renvoie des
// dates sous forme de texte ("YYYY-MM-DD HH:MM:SS"). On force donc pg à
// laisser ces colonnes en texte brut, pour rester compatible sans toucher
// à server.js.
types.setTypeParser(1082, (val) => val); // DATE
types.setTypeParser(1114, (val) => val); // TIMESTAMP WITHOUT TIME ZONE
types.setTypeParser(1184, (val) => val); // TIMESTAMP WITH TIME ZONE

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("ERREUR: DATABASE_URL manquant (URL de connexion Neon).");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Neon exige TLS. rejectUnauthorized:false évite les soucis de chaîne de
  // certificats sur certains environnements (Render inclus).
  ssl: { rejectUnauthorized: false },
});

// Crée les tables si elles n'existent pas encore (premier lancement),
// puis applique les migrations douces (nouvelles colonnes ajoutées au fil du temps).
async function init() {
  const schema = fs.readFileSync(path.join(__dirname, "schema.postgres.sql"), "utf8");
  await pool.query(schema);

  for (const stmt of [
    "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS referral_code TEXT",
    "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS referred_by INTEGER",
    "ALTER TABLE accounts ADD COLUMN IF NOT EXISTS referral_earnings INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS minecraft_pseudo TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE markets ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP",
    "ALTER TABLE bets ADD COLUMN IF NOT EXISTS refunded INTEGER NOT NULL DEFAULT 0",
  ]) {
    await pool.query(stmt);
  }

  await pool.query(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_referral_code ON accounts(referral_code)"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS idx_accounts_referred_by ON accounts(referred_by)"
  );
}

const ready = init().catch((err) => {
  console.error("Erreur d'initialisation de la base Postgres :", err);
  process.exit(1);
});

/* ---------- petites adaptations de syntaxe MySQL/SQLite -> Postgres ---------- */

function translate(sql) {
  // CURDATE() (MySQL) -> CURRENT_DATE (Postgres). NOW() est déjà valide en Postgres.
  return sql.replace(/\bCURDATE\(\)/gi, "CURRENT_DATE");
}

function isSelect(sql) {
  return /^\s*SELECT/i.test(sql);
}

function isInsert(sql) {
  return /^\s*INSERT\s+INTO/i.test(sql);
}

// Convertit les placeholders "?" (style mysql2/sqlite) en "$1, $2, ..." (style pg)
function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/* ---------- API compatible avec mysql2/promise (sous-ensemble utilisé) ---------- */

async function runQuery(exec, sql, params = []) {
  let translated = translate(sql);
  const wantsId = isInsert(translated) && !/RETURNING/i.test(translated);
  if (wantsId) translated += " RETURNING id";

  const pgSql = toPgPlaceholders(translated);
  const result = await exec(pgSql, params);

  if (isSelect(translated)) {
    return [result.rows];
  }
  const insertId = result.rows && result.rows[0] ? result.rows[0].id : undefined;
  return [{ insertId, affectedRows: result.rowCount }];
}

async function query(sql, params = []) {
  await ready;
  return runQuery((s, p) => pool.query(s, p), sql, params);
}

async function getConnection() {
  await ready;
  const client = await pool.connect();
  return {
    query: (sql, params = []) => runQuery((s, p) => client.query(s, p), sql, params),
    beginTransaction: () => client.query("BEGIN"),
    commit: () => client.query("COMMIT"),
    rollback: async () => {
      try {
        await client.query("ROLLBACK");
      } catch (e) {
        // pas de transaction en cours, on ignore
      }
    },
    release: () => client.release(),
  };
}

module.exports = { query, getConnection };
