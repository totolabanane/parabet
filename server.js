require("dotenv").config();

const path = require("path");
const fs = require("fs");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const pool = require("./db");

const {
  PORT = 3000,
  JWT_SECRET,
  ADMIN_CODE = "",
  START_BALANCE = 500,
  DAILY_BONUS = 50,
  DEPOSIT_MIN_AMOUNT = 50,
  WITHDRAW_MIN_AMOUNT = 15000,
  REFERRAL_BONUS_REFERRER = 100,
  REFERRAL_BONUS_REFEREE = 50,
} = process.env;

if (!JWT_SECRET) {
  console.error("ERREUR: JWT_SECRET manquant dans le fichier .env");
  process.exit(1);
}

const START_BAL = Number(START_BALANCE);
const DAILY_BON = Number(DAILY_BONUS);
const DEP_MIN = Number(DEPOSIT_MIN_AMOUNT);
const WD_MIN = Number(WITHDRAW_MIN_AMOUNT);
const REF_BONUS_REFERRER = Number(REFERRAL_BONUS_REFERRER);
const REF_BONUS_REFEREE = Number(REFERRAL_BONUS_REFEREE);

/* ---------- base de données ---------- */
// La connexion et la création des tables sont gérées dans db.js (SQLite, fichier local).

/* ---------- dossier des captures d'écran ---------- */

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || ".jpg").toLowerCase();
      const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
      cb(null, `dep_${Date.now()}_${Math.round(Math.random() * 1e9)}${safeExt}`);
    },
  }),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 Mo max
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Le fichier doit être une image."));
    cb(null, true);
  },
});

/* ---------- app ---------- */

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/uploads", express.static(UPLOAD_DIR));

/* ---------- aides ---------- */

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function signToken(account) {
  return jwt.sign(
    { id: account.id, pseudo: account.pseudo, isAdmin: !!account.is_admin },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

function setAuthCookie(res, token) {
  res.cookie("token", token, {
    httpOnly: true,
    sameSite: "lax",
    // secure: true, // active ça dès que le site tourne en HTTPS (recommandé en prod)
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function marketRowToJson(m) {
  return {
    id: m.id,
    category: m.category,
    title: m.title,
    yes: m.yes_pct,
    volume: m.volume,
    closes: m.closes_label,
    status: m.status,
    resolution: m.resolution,
  };
}

function depositRowToJson(d) {
  return {
    id: d.id,
    pseudo: d.pseudo,
    amount: d.amount,
    screenshot: `/uploads/${d.screenshot_file}`,
    status: d.status,
    ts: new Date(d.created_at).getTime(),
  };
}

function withdrawalRowToJson(w) {
  return {
    id: w.id,
    pseudo: w.pseudo,
    minecraftPseudo: w.minecraft_pseudo,
    amount: w.amount,
    status: w.status,
    ts: new Date(w.created_at).getTime(),
  };
}

/* ---------- parrainage : génération d'un code unique ---------- */

function randomCode(len = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sans O/0/I/1 pour éviter les confusions
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function generateUniqueReferralCode() {
  for (let i = 0; i < 20; i++) {
    const code = randomCode(6);
    const [rows] = await pool.query("SELECT id FROM accounts WHERE referral_code = ?", [code]);
    if (!rows.length) return code;
  }
  // filet de sécurité, extrêmement improbable de l'atteindre
  return randomCode(6) + Date.now().toString(36).slice(-3).toUpperCase();
}

// Pour les comptes créés avant l'ajout du parrainage : génère et sauvegarde
// leur code au premier chargement, au lieu de leur en priver.
async function ensureReferralCode(account) {
  if (account.referral_code) return account.referral_code;
  const code = await generateUniqueReferralCode();
  await pool.query("UPDATE accounts SET referral_code = ? WHERE id = ?", [code, account.id]);
  account.referral_code = code;
  return code;
}

/* ---------- middlewares d'authentification ---------- */

function authRequired(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Non connecté." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.clearCookie("token");
    return res.status(401).json({ error: "Session invalide, reconnecte-toi." });
  }
}

function adminRequired(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: "Accès réservé au staff." });
  next();
}

/* ================= AUTH ================= */

app.post("/api/register", async (req, res) => {
  try {
    let { pseudo, password, confirm, code, ref } = req.body || {};
    pseudo = String(pseudo || "").trim();
    password = String(password || "");
    confirm = String(confirm || "");
    code = String(code || "");
    ref = String(ref || "").trim().toUpperCase();

    if (pseudo.length < 3 || pseudo.length > 20)
      return res.status(400).json({ error: "Le pseudo doit faire entre 3 et 20 caractères." });
    if (!/^[a-zA-Z0-9_]+$/.test(pseudo))
      return res.status(400).json({ error: "Le pseudo ne peut contenir que lettres, chiffres et underscores." });
    if (password.length < 4)
      return res.status(400).json({ error: "Le mot de passe doit faire au moins 4 caractères." });
    if (password !== confirm)
      return res.status(400).json({ error: "Les mots de passe ne correspondent pas." });

    const pseudoLower = pseudo.toLowerCase();
    const [existing] = await pool.query("SELECT id FROM accounts WHERE pseudo_lower = ?", [pseudoLower]);
    if (existing.length) return res.status(400).json({ error: "Ce pseudo est déjà pris." });

    // parrain éventuel : on vérifie que le code correspond bien à un compte existant
    let referrer = null;
    if (ref) {
      const [rrows] = await pool.query("SELECT id, pseudo, balance FROM accounts WHERE referral_code = ?", [ref]);
      referrer = rrows[0] || null;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const isAdmin = ADMIN_CODE && code.trim() === ADMIN_CODE ? 1 : 0;
    const referralCode = await generateUniqueReferralCode();
    const startBalance = START_BAL + (referrer ? REF_BONUS_REFEREE : 0);

    const [result] = await pool.query(
      "INSERT INTO accounts (pseudo, pseudo_lower, password_hash, balance, is_admin, referral_code, referred_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [pseudo, pseudoLower, passwordHash, startBalance, isAdmin, referralCode, referrer ? referrer.id : null]
    );

    if (referrer) {
      await pool.query(
        "UPDATE accounts SET balance = balance + ?, referral_earnings = referral_earnings + ? WHERE id = ?",
        [REF_BONUS_REFERRER, REF_BONUS_REFERRER, referrer.id]
      );
      await pool.query(
        "INSERT INTO feed (pseudo, side, amount, title) VALUES ('Staff', 'yes', 0, ?)",
        [`🤝 ${referrer.pseudo} a parrainé ${pseudo} : +${REF_BONUS_REFERRER} 💎`]
      );
    }

    const account = { id: result.insertId, pseudo, is_admin: isAdmin };
    setAuthCookie(res, signToken(account));
    res.json({ pseudo, balance: startBalance, isAdmin: !!isAdmin, lastBonusDate: null, referralCode });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors de l'inscription." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    let { pseudo, password } = req.body || {};
    pseudo = String(pseudo || "").trim();
    password = String(password || "");
    if (!pseudo || !password) return res.status(400).json({ error: "Renseigne ton pseudo et ton mot de passe." });

    const [rows] = await pool.query("SELECT * FROM accounts WHERE pseudo_lower = ?", [pseudo.toLowerCase()]);
    const account = rows[0];
    if (!account) return res.status(400).json({ error: "Pseudo ou mot de passe incorrect." });

    const ok = await bcrypt.compare(password, account.password_hash);
    if (!ok) return res.status(400).json({ error: "Pseudo ou mot de passe incorrect." });

    const referralCode = await ensureReferralCode(account);
    setAuthCookie(res, signToken(account));
    res.json({
      pseudo: account.pseudo,
      balance: account.balance,
      isAdmin: !!account.is_admin,
      lastBonusDate: account.last_bonus_date,
      referralCode,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors de la connexion." });
  }
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/api/me", authRequired, async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.user.id]);
  const account = rows[0];
  if (!account) return res.status(401).json({ error: "Compte introuvable." });
  const referralCode = await ensureReferralCode(account);
  res.json({
    pseudo: account.pseudo,
    balance: account.balance,
    isAdmin: !!account.is_admin,
    lastBonusDate: account.last_bonus_date,
    referralCode,
  });
});

app.post("/api/bonus", authRequired, async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.user.id]);
  const account = rows[0];
  if (!account) return res.status(401).json({ error: "Compte introuvable." });

  const last = account.last_bonus_date ? new Date(account.last_bonus_date).toISOString().slice(0, 10) : null;
  if (last === todayStr()) return res.status(400).json({ error: "Bonus déjà réclamé aujourd'hui." });

  const newBalance = account.balance + DAILY_BON;
  await pool.query("UPDATE accounts SET balance = ?, last_bonus_date = CURDATE() WHERE id = ?", [newBalance, account.id]);
  res.json({ balance: newBalance, bonus: DAILY_BON });
});

/* ================= MARCHÉS & FEED ================= */

app.get("/api/markets", authRequired, async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM markets ORDER BY created_at ASC");
  res.json(rows.map(marketRowToJson));
});

app.get("/api/feed", authRequired, async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM feed ORDER BY created_at DESC LIMIT 25");
  res.json(
    rows.reverse().map(f => ({ pseudo: f.pseudo, side: f.side, amount: f.amount, title: f.title, ts: new Date(f.created_at).getTime() }))
  );
});

app.get("/api/mybets", authRequired, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT b.*, m.title AS market_title FROM bets b
     JOIN markets m ON m.id = b.market_id
     WHERE b.account_id = ? ORDER BY b.created_at DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(rows.map(b => ({
    marketId: b.market_id, title: b.market_title, side: b.side,
    amount: b.amount, price: b.price, ts: new Date(b.created_at).getTime(),
  })));
});

app.post("/api/bets", authRequired, async (req, res) => {
  const { marketId, side, amount } = req.body || {};
  if (!marketId || (side !== "yes" && side !== "no")) return res.status(400).json({ error: "Requête invalide." });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [mrows] = await conn.query("SELECT * FROM markets WHERE id = ? FOR UPDATE", [marketId]);
    const market = mrows[0];
    if (!market || market.status !== "open") {
      await conn.rollback();
      return res.status(400).json({ error: "Ce marché n'est plus ouvert." });
    }

    const [arows] = await conn.query("SELECT * FROM accounts WHERE id = ? FOR UPDATE", [req.user.id]);
    const account = arows[0];
    const stake = clamp(Math.round(Number(amount)), 10, account.balance);
    if (stake < 10 || stake > account.balance) {
      await conn.rollback();
      return res.status(400).json({ error: "Mise invalide : pas assez d'émeraudes." });
    }

    const priceAtBet = side === "yes" ? market.yes_pct : 100 - market.yes_pct;
    const impact = (stake / (market.volume + stake + 150)) * 45;
    let newYes = side === "yes" ? market.yes_pct + impact : market.yes_pct - impact;
    newYes = clamp(Math.round(newYes), 2, 98);
    const newVolume = market.volume + stake;

    await conn.query("UPDATE markets SET yes_pct = ?, volume = ? WHERE id = ?", [newYes, newVolume, marketId]);
    await conn.query("UPDATE accounts SET balance = balance - ? WHERE id = ?", [stake, req.user.id]);
    await conn.query(
      "INSERT INTO bets (market_id, account_id, side, amount, price) VALUES (?, ?, ?, ?, ?)",
      [marketId, req.user.id, side, stake, priceAtBet]
    );
    await conn.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, ?, ?)",
      [req.user.pseudo, side, stake, market.title]
    );

    await conn.commit();
    res.json({ balance: account.balance - stake, stake });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors de la mise." });
  } finally {
    conn.release();
  }
});

/* ================= DÉPÔTS (joueur) ================= */

app.post("/api/deposits", authRequired, upload.single("screenshot"), async (req, res) => {
  try {
    const amount = clamp(Math.round(Number(req.body.amount) || 0), DEP_MIN, 1000000);
    if (!req.file) return res.status(400).json({ error: "Ajoute une capture d'écran prouvant le dépôt en jeu." });

    await pool.query(
      "INSERT INTO deposits (account_id, amount, screenshot_file, status) VALUES (?, ?, ?, 'pending')",
      [req.user.id, amount, req.file.filename]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors de l'envoi du dépôt." });
  }
});

app.get("/api/mydeposits", authRequired, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT d.*, a.pseudo FROM deposits d JOIN accounts a ON a.id = d.account_id WHERE d.account_id = ? ORDER BY d.created_at DESC LIMIT 20",
    [req.user.id]
  );
  res.json(rows.map(depositRowToJson));
});

/* ================= RETRAITS (joueur) ================= */

// Le joueur demande un retrait : le montant est réservé immédiatement (débité
// du solde ParaBet) pour éviter qu'il puisse le miser en attendant la
// validation. Le staff paie ensuite les émeraudes en jeu et approuve la
// demande dans l'onglet Admin. En cas de refus, le solde est recrédité.
app.post("/api/withdrawals", authRequired, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const amount = Math.round(Number(req.body?.amount) || 0);
    const minecraftPseudo = String(req.body?.minecraftPseudo || "").trim();

    if (amount < WD_MIN) {
      conn.release();
      return res.status(400).json({ error: `Le retrait minimum est de ${WD_MIN} 💎.` });
    }
    if (minecraftPseudo.length < 3 || minecraftPseudo.length > 20 || !/^[a-zA-Z0-9_]+$/.test(minecraftPseudo)) {
      conn.release();
      return res.status(400).json({ error: "Indique ton pseudo Paladium (Minecraft) valide pour être payé en jeu." });
    }

    await conn.beginTransaction();
    const [arows] = await conn.query("SELECT * FROM accounts WHERE id = ? FOR UPDATE", [req.user.id]);
    const account = arows[0];
    if (!account || amount > account.balance) {
      await conn.rollback();
      return res.status(400).json({ error: "Solde insuffisant pour ce retrait." });
    }

    await conn.query("UPDATE accounts SET balance = balance - ? WHERE id = ?", [amount, account.id]);
    await conn.query(
      "INSERT INTO withdrawals (account_id, amount, minecraft_pseudo, status) VALUES (?, ?, ?, 'pending')",
      [account.id, amount, minecraftPseudo]
    );

    await conn.commit();
    res.json({ ok: true, balance: account.balance - amount });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors de la demande de retrait." });
  } finally {
    conn.release();
  }
});

app.get("/api/mywithdrawals", authRequired, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT w.*, a.pseudo FROM withdrawals w JOIN accounts a ON a.id = w.account_id WHERE w.account_id = ? ORDER BY w.created_at DESC LIMIT 20",
    [req.user.id]
  );
  res.json(rows.map(withdrawalRowToJson));
});

/* ================= PARRAINAGE (joueur) ================= */

app.get("/api/referrals", authRequired, async (req, res) => {
  const [arows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.user.id]);
  const account = arows[0];
  if (!account) return res.status(401).json({ error: "Compte introuvable." });
  const referralCode = await ensureReferralCode(account);

  const [referred] = await pool.query(
    "SELECT pseudo, created_at FROM accounts WHERE referred_by = ? ORDER BY created_at DESC",
    [req.user.id]
  );

  res.json({
    code: referralCode,
    bonusReferrer: REF_BONUS_REFERRER,
    bonusReferee: REF_BONUS_REFEREE,
    totalEarned: account.referral_earnings,
    count: referred.length,
    referred: referred.map(r => ({ pseudo: r.pseudo, ts: new Date(r.created_at).getTime() })),
  });
});

/* ================= ADMIN : JOUEURS ================= */

app.get("/api/admin/accounts", authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query(`
    SELECT
      a.id, a.pseudo, a.balance, a.is_admin, a.created_at,
      a.referral_code, a.referral_earnings,
      ref.pseudo AS referred_by_pseudo,
      COALESCE(bs.bet_count, 0) AS bet_count,
      COALESCE(bs.total_wagered, 0) AS total_wagered
    FROM accounts a
    LEFT JOIN accounts ref ON ref.id = a.referred_by
    LEFT JOIN (
      SELECT account_id, COUNT(*) AS bet_count, SUM(amount) AS total_wagered
      FROM bets GROUP BY account_id
    ) bs ON bs.account_id = a.id
    ORDER BY a.created_at DESC
  `);
  res.json(rows.map(a => ({
    id: a.id,
    pseudo: a.pseudo,
    balance: a.balance,
    isAdmin: !!a.is_admin,
    createdAt: new Date(a.created_at).getTime(),
    referralCode: a.referral_code,
    referredByPseudo: a.referred_by_pseudo || null,
    referralEarnings: a.referral_earnings,
    betCount: a.bet_count,
    totalWagered: a.total_wagered,
  })));
});

app.get("/api/admin/accounts/:id/bets", authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT b.*, m.title AS market_title, m.status AS market_status, m.resolution AS market_resolution
     FROM bets b JOIN markets m ON m.id = b.market_id
     WHERE b.account_id = ? ORDER BY b.created_at DESC`,
    [req.params.id]
  );
  res.json(rows.map(b => ({
    marketId: b.market_id,
    title: b.market_title,
    side: b.side,
    amount: b.amount,
    price: b.price,
    marketStatus: b.market_status,
    marketResolution: b.market_resolution,
    ts: new Date(b.created_at).getTime(),
  })));
});

/* ================= ADMIN : MARCHÉS ================= */

app.post("/api/admin/markets", authRequired, adminRequired, async (req, res) => {
  const { title, category, yes, closes } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: "Ajoute un titre au marché." });

  const id = "m" + Date.now();
  const yesPct = clamp(Math.round(Number(yes) || 50), 2, 98);
  await pool.query(
    "INSERT INTO markets (id, category, title, yes_pct, volume, closes_label, status) VALUES (?, ?, ?, ?, 0, ?, 'open')",
    [id, category || "guerre", String(title).trim(), yesPct, (closes && String(closes).trim()) || "Indéterminée"]
  );
  res.json({ id });
});

app.delete("/api/admin/markets/:id", authRequired, adminRequired, async (req, res) => {
  await pool.query("DELETE FROM markets WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

app.post("/api/admin/markets/:id/resolve", authRequired, adminRequired, async (req, res) => {
  const { outcome } = req.body || {};
  if (outcome !== "yes" && outcome !== "no") return res.status(400).json({ error: "Résultat invalide." });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [mrows] = await conn.query("SELECT * FROM markets WHERE id = ? FOR UPDATE", [req.params.id]);
    const market = mrows[0];
    if (!market || market.status === "resolved") {
      await conn.rollback();
      return res.status(400).json({ error: "Marché introuvable ou déjà résolu." });
    }

    const [winners] = await conn.query("SELECT * FROM bets WHERE market_id = ? AND side = ?", [req.params.id, outcome]);
    for (const b of winners) {
      const payout = Math.round((b.amount * 100) / Math.max(2, b.price));
      await conn.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [payout, b.account_id]);
    }

    await conn.query("UPDATE markets SET status = 'resolved', resolution = ? WHERE id = ?", [outcome, req.params.id]);
    await conn.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES ('Staff', ?, 0, ?)",
      [outcome, `🏁 Résultat — ${market.title} : ${outcome === "yes" ? "Oui" : "Non"}`]
    );

    await conn.commit();
    res.json({ paid: winners.length });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors de la résolution." });
  } finally {
    conn.release();
  }
});

/* ================= ADMIN : DÉPÔTS ================= */

app.get("/api/admin/deposits", authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT d.*, a.pseudo FROM deposits d JOIN accounts a ON a.id = d.account_id ORDER BY d.created_at DESC"
  );
  res.json(rows.map(depositRowToJson));
});

app.post("/api/admin/deposits/:id/approve", authRequired, adminRequired, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [drows] = await conn.query("SELECT * FROM deposits WHERE id = ? FOR UPDATE", [req.params.id]);
    const dep = drows[0];
    if (!dep || dep.status !== "pending") {
      await conn.rollback();
      return res.status(400).json({ error: "Ce dépôt n'est plus en attente." });
    }

    await conn.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [dep.amount, dep.account_id]);
    await conn.query("UPDATE deposits SET status = 'approved', reviewed_at = NOW() WHERE id = ?", [dep.id]);

    const [arows] = await conn.query("SELECT pseudo FROM accounts WHERE id = ?", [dep.account_id]);
    const pseudo = arows[0] ? arows[0].pseudo : "?";
    await conn.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES ('Staff', 'yes', 0, ?)",
      [`🏦 Dépôt validé pour ${pseudo} : +${dep.amount} 💎`]
    );

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors de l'approbation." });
  } finally {
    conn.release();
  }
});

app.post("/api/admin/deposits/:id/reject", authRequired, adminRequired, async (req, res) => {
  const [result] = await pool.query(
    "UPDATE deposits SET status = 'rejected', reviewed_at = NOW() WHERE id = ? AND status = 'pending'",
    [req.params.id]
  );
  if (!result.affectedRows) return res.status(400).json({ error: "Ce dépôt n'est plus en attente." });
  res.json({ ok: true });
});

app.delete("/api/admin/deposits/:id", authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM deposits WHERE id = ?", [req.params.id]);
  const dep = rows[0];
  if (dep) {
    const filePath = path.join(UPLOAD_DIR, dep.screenshot_file);
    fs.unlink(filePath, () => {});
  }
  await pool.query("DELETE FROM deposits WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

/* ================= ADMIN : RETRAITS ================= */

app.get("/api/admin/withdrawals", authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT w.*, a.pseudo FROM withdrawals w JOIN accounts a ON a.id = w.account_id ORDER BY w.created_at DESC"
  );
  res.json(rows.map(withdrawalRowToJson));
});

// Approuver = le staff confirme avoir payé les émeraudes en jeu. Le solde a
// déjà été débité à la demande, donc rien à faire côté solde ici.
app.post("/api/admin/withdrawals/:id/approve", authRequired, adminRequired, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [wrows] = await conn.query("SELECT * FROM withdrawals WHERE id = ? FOR UPDATE", [req.params.id]);
    const wd = wrows[0];
    if (!wd || wd.status !== "pending") {
      await conn.rollback();
      return res.status(400).json({ error: "Ce retrait n'est plus en attente." });
    }

    await conn.query("UPDATE withdrawals SET status = 'approved', reviewed_at = NOW() WHERE id = ?", [wd.id]);

    const [arows] = await conn.query("SELECT pseudo FROM accounts WHERE id = ?", [wd.account_id]);
    const pseudo = arows[0] ? arows[0].pseudo : "?";
    await conn.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES ('Staff', 'no', 0, ?)",
      [`🏧 Retrait payé à ${pseudo} : -${wd.amount} 💎`]
    );

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors de l'approbation." });
  } finally {
    conn.release();
  }
});

// Refuser = on recrédite le solde du joueur, puisqu'il avait été réservé à la demande.
app.post("/api/admin/withdrawals/:id/reject", authRequired, adminRequired, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [wrows] = await conn.query("SELECT * FROM withdrawals WHERE id = ? FOR UPDATE", [req.params.id]);
    const wd = wrows[0];
    if (!wd || wd.status !== "pending") {
      await conn.rollback();
      return res.status(400).json({ error: "Ce retrait n'est plus en attente." });
    }

    await conn.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [wd.amount, wd.account_id]);
    await conn.query("UPDATE withdrawals SET status = 'rejected', reviewed_at = NOW() WHERE id = ?", [wd.id]);

    await conn.commit();
    res.json({ ok: true });
  } catch (e) {
    await conn.rollback();
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors du refus." });
  } finally {
    conn.release();
  }
});

app.delete("/api/admin/withdrawals/:id", authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM withdrawals WHERE id = ?", [req.params.id]);
  const wd = rows[0];
  if (wd && wd.status === "pending") {
    return res.status(400).json({ error: "Refuse ou approuve d'abord ce retrait avant de le supprimer." });
  }
  await pool.query("DELETE FROM withdrawals WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

/* ================= FRONTEND STATIQUE ================= */

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/uploads")) return res.status(404).end();
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`ParaBet backend lancé sur http://localhost:${PORT}`));
