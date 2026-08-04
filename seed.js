// seed.js — crée quelques marchés d'exemple dans la base.
// Lancement : node seed.js

require("dotenv").config();
const pool = require("./db");

const markets = [
  {
    category: "event",
    title: "FuzeIII sort une vidéo sur Paladium dans la semaine du 10 août 2026",
    yes: 50,
    closes: "10 août 2026",
  },
  {
    category: "economie",
    title: "50 joueurs atteignent le niveau 20 en Farmeur avant le 10 août 2026",
    yes: 50,
    closes: "10 août 2026",
  },
  {
    category: "economie",
    title: "Le joueur le plus riche du serveur aura 5 000 000 💎 ou plus",
    yes: 50,
    closes: "Indéterminée",
  },
  {
    category: "guerre",
    title: "La FuzeFaction termine 1ère au classement faction",
    yes: 50,
    closes: "Indéterminée",
  },
  {
    category: "rumeur",
    title: "La Nigma recrute plus de 10 membres dans la semaine du 3 août 2026",
    yes: 50,
    closes: "3 août 2026",
  },
];

(async () => {
  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const id = `m${Date.now()}${i}`;
    await pool.query(
      "INSERT INTO markets (id, category, title, yes_pct, volume, closes_label, status) VALUES (?, ?, ?, ?, 0, ?, 'open')",
      [id, m.category, m.title, m.yes, m.closes]
    );
    console.log(`✔ ${m.title}`);
  }
  console.log("\nTerminé : 5 marchés créés.");
  process.exit(0);
})();
