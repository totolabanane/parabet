// migrate-to-neon.js — copie les données de l'ancien parabet.db (SQLite)
// vers la base Postgres (Neon) pointée par DATABASE_URL.
//
// Utilisation :
//   1. Assure-toi que le fichier parabet.db (l'ancien, avec tes vraies données)
//      est présent à la racine du projet.
//   2. Assure-toi que DATABASE_URL est bien réglée dans .env (Neon).
//   3. npm install
//   4. node migrate-to-neon.js
//
// Le script insère les lignes dans l'ordre des dépendances (accounts, markets,
// bets, feed, deposits, withdrawals, casino_bets), en conservant les id
// d'origine (nécessaire pour les clés étrangères), puis remet à jour les
// séquences Postgres (SERIAL) pour que les prochains inserts de l'appli
// continuent au bon endroit.

require("dotenv").config();
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { Pool } = require("pg");

const SQLITE_FILE = process.env.OLD_DB_FILE || path.join(__dirname, "parabet.db");
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("ERREUR: DATABASE_URL manquant dans .env");
  process.exit(1);
}

const TABLES = ["accounts", "markets", "bets", "feed", "deposits", "withdrawals", "casino_bets"];

async function main() {
  const sqlite = new DatabaseSync(SQLITE_FILE);
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const table of TABLES) {
      const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
      const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();

      if (rows.length === 0) {
        console.log(`- ${table}: rien à migrer`);
        continue;
      }

      // On vide la table cible d'abord, pour pouvoir relancer le script sans doublons.
      await client.query(`DELETE FROM ${table}`);

      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const insertSql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders})`;

      for (const row of rows) {
        const values = cols.map((c) => row[c]);
        await client.query(insertSql, values);
      }

      // Remet à jour la séquence SERIAL, uniquement pour les tables concernées
      // (markets a un id VARCHAR, pas de séquence à remettre à jour).
      const SERIAL_TABLES = ["accounts", "bets", "feed", "deposits", "withdrawals", "casino_bets"];
      if (SERIAL_TABLES.includes(table)) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), true)`
        );
      }

      console.log(`✔ ${table}: ${rows.length} lignes migrées`);
    }

    await client.query("COMMIT");
    console.log("\nMigration terminée avec succès.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Erreur pendant la migration, tout a été annulé :", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
