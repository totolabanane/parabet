require("dotenv").config();

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
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
  DISCORD_WEBHOOK_URL = "",
} = process.env;

if (!JWT_SECRET) {
  console.error("ERREUR: JWT_SECRET manquant dans le fichier .env");
  process.exit(1);
}

const START_BAL = Number(START_BALANCE);
const DAILY_BON = Number(DAILY_BONUS);
const BONUS_COOLDOWN_MS = 24 * 60 * 60 * 1000; // le bonus quotidien redevient disponible 24h après la dernière réclamation
const DEP_MIN = Number(DEPOSIT_MIN_AMOUNT);
const WD_MIN = Number(WITHDRAW_MIN_AMOUNT);
const REF_BONUS_REFERRER = Number(REFERRAL_BONUS_REFERRER);
const REF_BONUS_REFEREE = Number(REFERRAL_BONUS_REFEREE);

/* ---------- notifications Discord ---------- */
// Construit une URL publique absolue (https derrière un proxy) à partir d'un chemin relatif,
// par ex. buildPublicUrl(req, "/uploads/xxx.png") -> "https://mon-domaine.com/uploads/xxx.png"
function buildPublicUrl(req, relativePath) {
  return `${req.protocol}://${req.get("host")}${relativePath}`;
}

// Discord n'autorise les boutons cliquables (components) que sur les webhooks
// liés à une application/bot — un simple webhook de salon ne peut pas déclencher
// d'action au clic. On utilise donc des liens sécurisés (signés en HMAC avec
// JWT_SECRET) glissés dans l'embed : cliquer dessus dans Discord ouvre le
// navigateur et valide/refuse directement, sans avoir besoin d'être connecté.
function signAdminAction(kind, id) {
  return crypto.createHmac("sha256", JWT_SECRET).update(`${kind}:${id}`).digest("hex").slice(0, 32);
}

function verifyAdminAction(kind, id, token) {
  if (!token || typeof token !== "string") return false;
  const expected = signAdminAction(kind, id);
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function adminActionLink(req, path, kind, id) {
  return buildPublicUrl(req, `${path}?token=${signAdminAction(kind, id)}`);
}

// Petite page HTML de confirmation affichée quand le staff clique sur un lien
// de validation/refus depuis Discord.
function actionResultHtml(message, ok = true) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ParaBet</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0d0e18; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; text-align: center; }
  .card { background: #14152280; border: 1px solid #ffffff1a; border-radius: 16px; padding: 32px 24px; max-width: 420px; }
  .icon { font-size: 40px; margin-bottom: 12px; }
  p { font-size: 16px; line-height: 1.5; }
  a { color: #9c6bff; }
</style></head>
<body><div class="card"><div class="icon">${ok ? "✅" : "⚠️"}</div><p>${message}</p></div></body></html>`;
}

// Petite page HTML avec un champ texte, affichée quand le staff clique sur le
// lien "❌ Refuser" depuis Discord : on exige toujours une raison (affichée
// ensuite au joueur), donc pas de refus en un clic direct depuis l'embed.
function rejectReasonFormHtml(kind, id, token) {
  const label = kind === "deposit" ? "ce dépôt" : "ce retrait";
  return `<!DOCTYPE html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ParaBet</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0d0e18; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
  .card { background: #14152280; border: 1px solid #ffffff1a; border-radius: 16px; padding: 32px 24px; max-width: 420px; width: 100%; text-align: center; }
  .icon { font-size: 40px; margin-bottom: 12px; }
  p { font-size: 15px; line-height: 1.5; }
  textarea { width: 100%; box-sizing: border-box; min-height: 90px; margin-top: 12px; border-radius: 10px; border: 1px solid #ffffff33; background: #0d0e18; color: #fff; padding: 10px; font-size: 14px; resize: vertical; }
  button { margin-top: 14px; background: #ff5c5c; color: #fff; border: none; border-radius: 10px; padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  .err { color: #ff8a8a; font-size: 13px; margin-top: 8px; min-height: 16px; }
</style></head>
<body><div class="card">
  <div class="icon">⚠️</div>
  <p>Indique la raison du refus de ${label} — elle sera affichée au joueur.</p>
  <textarea id="reason" maxlength="300" placeholder="Ex : capture d'écran illisible / montant incohérent…"></textarea>
  <div class="err" id="err"></div>
  <button id="submitBtn">🚫 Refuser avec cette raison</button>
</div>
<script>
  document.getElementById("submitBtn").addEventListener("click", async () => {
    const reason = document.getElementById("reason").value.trim();
    const errEl = document.getElementById("err");
    if (!reason) { errEl.textContent = "La raison est obligatoire."; return; }
    const btn = document.getElementById("submitBtn");
    btn.disabled = true; errEl.textContent = "";
    try {
      const r = await fetch(${JSON.stringify(`/api/admin/${kind}s/${id}/reject-with-token`)}, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: ${JSON.stringify(token)}, reason }),
      });
      document.open(); document.write(await r.text()); document.close();
    } catch (e) {
      btn.disabled = false; errEl.textContent = "Erreur réseau, réessaie.";
    }
  });
</script>
</body></html>`;
}

// Envoie un embed vers le webhook Discord configuré dans .env (DISCORD_WEBHOOK_URL).
// Ne bloque jamais la requête HTTP en cours : les erreurs sont juste loguées.
async function notifyDiscord({ title, color, fields, imageUrl, thumbnailUrl }) {
  if (!DISCORD_WEBHOOK_URL) return; // pas de webhook configuré -> on ignore silencieusement

  const embed = {
    title,
    color,
    fields,
    timestamp: new Date().toISOString(),
  };
  if (imageUrl) embed.image = { url: imageUrl };
  if (thumbnailUrl) embed.thumbnail = { url: thumbnailUrl };

  const payload = { embeds: [embed] };

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("Webhook Discord: réponse non-OK", res.status, await res.text().catch(() => ""));
    }
  } catch (e) {
    console.error("Webhook Discord: échec d'envoi", e);
  }
}

/* ---------- base de données ---------- */
// La connexion et la création des tables sont gérées dans db.js (Postgres / Neon).

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
app.set("trust proxy", true); // pour construire des URLs publiques correctes (https) derrière un proxy/CDN
app.use(express.json());
app.use(cookieParser());
app.use("/uploads", express.static(UPLOAD_DIR));

/* ---------- aides ---------- */

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

// Le bonus quotidien redevient disponible 24h pile après la dernière réclamation
// (et non au changement de date calendaire). last_bonus_date est stocké en base
// comme un timestamp epoch (ms) — voir /api/bonus.
function computeNextBonusAt(account) {
  const last = account && account.last_bonus_date != null ? Number(account.last_bonus_date) : null;
  return last != null && Number.isFinite(last) ? last + BONUS_COOLDOWN_MS : null;
}

// Exigence de mise ("wagering requirement") : chaque dépôt approuvé ajoute son
// montant à wagering_required (voir /api/admin/deposits/:id/approve). Chaque
// mise placée (marché de prédiction ou jeu de casino) fait progresser
// wagering_progress d'autant, plafonné à wagering_required — impossible de
// "dépasser" l'objectif. Le retrait est bloqué tant que
// wagering_progress < wagering_required (voir /api/withdrawals).
// `q` est soit `pool`, soit une connexion de transaction (`conn`).
async function addWageringProgress(q, accountId, stakeAmount) {
  if (!stakeAmount) return;
  await q.query(
    "UPDATE accounts SET wagering_progress = LEAST(wagering_progress + ?, wagering_required) WHERE id = ?",
    [stakeAmount, accountId]
  );
}

// Renvoie { wageringRequired, wageringProgress } à jour pour un compte —
// à inclure dans les réponses après une mise, pour que le front puisse
// mettre à jour la barre de progression sans requête supplémentaire.
async function getWageringFields(q, accountId) {
  const [rows] = await q.query("SELECT wagering_required, wagering_progress FROM accounts WHERE id = ?", [accountId]);
  const a = rows[0] || { wagering_required: 0, wagering_progress: 0 };
  return { wageringRequired: a.wagering_required, wageringProgress: a.wagering_progress };
}

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
    resolvedAt: m.resolved_at ? new Date(m.resolved_at.replace(" ", "T") + "Z").getTime() : null,
  };
}

function depositRowToJson(d) {
  return {
    id: d.id,
    pseudo: d.pseudo,
    amount: d.amount,
    amountUsd: d.amount_usd != null ? Number(d.amount_usd) : null,
    screenshot: `/uploads/${d.screenshot_file}`,
    status: d.status,
    rejectReason: d.reject_reason || null,
    ts: new Date(d.created_at).getTime(),
  };
}

function withdrawalRowToJson(w) {
  return {
    id: w.id,
    pseudo: w.pseudo,
    minecraftPseudo: w.minecraft_pseudo,
    amount: w.amount,
    amountUsd: w.amount_usd != null ? Number(w.amount_usd) : null,
    taxPercent: w.tax_percent != null ? Number(w.tax_percent) : null,
    status: w.status,
    rejectReason: w.reject_reason || null,
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

    // Offre "parrainage boosté" active ? On utilise ses montants à la place
    // des valeurs par défaut (.env) tant qu'elle est active et non expirée.
    const referralOffer = referrer ? await getActiveOffer("referral_boost") : null;
    const refereeBonus = referralOffer ? Number(referralOffer.referee_bonus) : REF_BONUS_REFEREE;
    const referrerBonus = referralOffer ? Number(referralOffer.referrer_bonus) : REF_BONUS_REFERRER;

    const passwordHash = await bcrypt.hash(password, 10);
    const isAdmin = ADMIN_CODE && code.trim() === ADMIN_CODE ? 1 : 0;
    const referralCode = await generateUniqueReferralCode();
    // Le parrainage n'est plus crédité à l'inscription : le filleul doit d'abord
    // faire valider son 1er dépôt par le staff (voir approveDeposit()). On se
    // contente ici de "verrouiller" les montants de bonus (utile si une offre
    // boostée expire entre-temps) sur le compte du filleul.
    const startBalance = appSettings.startingBalance;

    const [result] = await pool.query(
      "INSERT INTO accounts (pseudo, pseudo_lower, password_hash, balance, is_admin, referral_code, referred_by, referral_bonus_referrer, referral_bonus_referee) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [pseudo, pseudoLower, passwordHash, startBalance, isAdmin, referralCode, referrer ? referrer.id : null, referrer ? referrerBonus : 0, referrer ? refereeBonus : 0]
    );

    if (referrer) {
      await pool.query(
        "INSERT INTO feed (pseudo, side, amount, title) VALUES ('Staff', 'yes', 0, ?)",
        [`🤝 ${pseudo} a rejoint ParaBet grâce au code de ${referrer.pseudo} — parrainage en attente du 1er dépôt`]
      );
    }

    const account = { id: result.insertId, pseudo, is_admin: isAdmin };
    setAuthCookie(res, signToken(account));
    res.json({ pseudo, balance: startBalance, isAdmin: !!isAdmin, nextBonusAt: null, referralCode, wageringRequired: 0, wageringProgress: 0 });
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
      nextBonusAt: computeNextBonusAt(account),
      referralCode,
      wageringRequired: account.wagering_required,
      wageringProgress: account.wagering_progress,
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
    nextBonusAt: computeNextBonusAt(account),
    referralCode,
    wageringRequired: account.wagering_required,
    wageringProgress: account.wagering_progress,
  });
});

app.post("/api/bonus", authRequired, async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.user.id]);
  const account = rows[0];
  if (!account) return res.status(401).json({ error: "Compte introuvable." });

  const nextBonusAt = computeNextBonusAt(account);
  if (nextBonusAt != null && Date.now() < nextBonusAt) {
    return res.status(400).json({ error: "Bonus déjà réclamé, reviens plus tard.", nextBonusAt });
  }

  const bonusAmount = appSettings.dailyBonusAmount;
  const claimedAt = Date.now();
  const newBalance = account.balance + bonusAmount;
  await pool.query("UPDATE accounts SET balance = ?, last_bonus_date = ? WHERE id = ?", [newBalance, claimedAt, account.id]);
  res.json({ balance: newBalance, bonus: bonusAmount, nextBonusAt: claimedAt + BONUS_COOLDOWN_MS });
});

/* ================= MARCHÉS & FEED ================= */

app.get("/api/markets", authRequired, async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM markets ORDER BY created_at ASC");
  res.json(rows.map(marketRowToJson));
});

// L'historique public n'affiche pas les ajustements de solde faits manuellement
// par le staff (ex: correction d'une erreur) — ce n'est pas une activité de jeu
// et ça n'a rien à faire dans le fil public. Ces lignes restent en base (utile
// pour l'audit admin) mais sont filtrées ici avant l'envoi au client.
app.get("/api/feed", authRequired, async (req, res) => {
  const [rows] = await pool.query(
    "SELECT * FROM feed WHERE title NOT LIKE '🛠️ Ajustement staff%' ORDER BY created_at DESC LIMIT 25"
  );
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
    amount: b.amount, price: b.price, refunded: !!b.refunded, ts: new Date(b.created_at).getTime(),
  })));
});

// Historique perso des parties de casino (pendant à /api/mybets côté marché),
// utilisé par l'onglet "Casino" de la page "Mon profil".
app.get("/api/mycasinobets", authRequired, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT * FROM casino_bets WHERE account_id = ? ORDER BY created_at DESC LIMIT 200`,
    [req.user.id]
  );
  res.json(rows.map(b => ({
    game: b.game, bet: b.bet, payout: b.payout, result: b.result,
    detail: b.detail, ts: new Date(b.created_at).getTime(),
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
      const msg = market && market.status === "locked"
        ? "Les paris sont temporairement bloqués sur ce marché."
        : "Ce marché n'est plus ouvert.";
      return res.status(400).json({ error: msg });
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
    await addWageringProgress(conn, req.user.id, stake);

    await conn.commit();
    const wagering = await getWageringFields(pool, req.user.id);
    res.json({ balance: account.balance - stake, stake, ...wagering });
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
    // Le joueur choisit son montant en $ ; le nombre de 💎 est calculé côté
    // serveur avec le taux courant (source de vérité, jamais fait confiance au client).
    const amountUsd = Math.round((Math.max(0, Number(req.body.amountUsd) || 0)) * 100) / 100;
    const amount = Math.round(usdToDiamonds(amountUsd));
    const minUsd = Math.ceil(DEP_MIN * appSettings.usdPerDiamond * 100) / 100;

    if (amount < DEP_MIN) {
      return res.status(400).json({ error: `Le montant minimum est de ${minUsd.toFixed(2)} $ (${DEP_MIN} 💎).` });
    }
    if (amount > 100000000) {
      return res.status(400).json({ error: "Montant trop élevé." });
    }
    if (!req.file) return res.status(400).json({ error: "Ajoute une capture d'écran prouvant le paiement en jeu." });

    const [result] = await pool.query(
      "INSERT INTO deposits (account_id, amount, amount_usd, screenshot_file, status) VALUES (?, ?, ?, ?, 'pending')",
      [req.user.id, amount, amountUsd, req.file.filename]
    );
    res.json({ ok: true });

    const depositId = result.insertId;
    const approveUrl = adminActionLink(req, `/api/admin/deposits/${depositId}/approve`, "deposit:approve", depositId);
    const rejectUrl = adminActionLink(req, `/api/admin/deposits/${depositId}/reject`, "deposit:reject", depositId);
    notifyDiscord({
      title: "💰 Nouveau dépôt en attente",
      color: 0x2ecc71,
      fields: [
        { name: "Joueur", value: req.user.pseudo || String(req.user.id), inline: true },
        { name: "Montant", value: `${amount} 💎 (${amountUsd.toFixed(2)} $)`, inline: true },
        { name: "Commande envoyée", value: `/pay ${appSettings.depositPayPseudo} ${amountUsd}`, inline: true },
        { name: "Actions", value: `[✅ Valider](${approveUrl})  ·  [❌ Refuser](${rejectUrl})` },
      ],
      imageUrl: buildPublicUrl(req, `/uploads/${req.file.filename}`),
    });
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

    if (account.wagering_progress < account.wagering_required) {
      await conn.rollback();
      const remaining = account.wagering_required - account.wagering_progress;
      return res.status(400).json({
        error: `Tu dois encore miser ${remaining} 💎 avant de pouvoir retirer (${account.wagering_progress}/${account.wagering_required} misés).`,
        wageringRequired: account.wagering_required,
        wageringProgress: account.wagering_progress,
      });
    }

    const amountUsd = diamondsToNetUsd(amount);
    const taxPercent = appSettings.withdrawTaxPercent;

    await conn.query("UPDATE accounts SET balance = balance - ? WHERE id = ?", [amount, account.id]);
    const [wResult] = await conn.query(
      "INSERT INTO withdrawals (account_id, amount, amount_usd, tax_percent, minecraft_pseudo, status) VALUES (?, ?, ?, ?, ?, 'pending')",
      [account.id, amount, amountUsd, taxPercent, minecraftPseudo]
    );

    await conn.commit();
    res.json({ ok: true, balance: account.balance - amount });

    const withdrawalId = wResult.insertId;
    const wApproveUrl = withdrawalId ? adminActionLink(req, `/api/admin/withdrawals/${withdrawalId}/approve`, "withdrawal:approve", withdrawalId) : null;
    const wRejectUrl = withdrawalId ? adminActionLink(req, `/api/admin/withdrawals/${withdrawalId}/reject`, "withdrawal:reject", withdrawalId) : null;
    notifyDiscord({
      title: "💸 Nouvelle demande de retrait",
      color: 0xe67e22,
      fields: [
        { name: "Joueur", value: req.user.pseudo || String(req.user.id), inline: true },
        { name: "Montant", value: `${amount} 💎 (${amountUsd.toFixed(2)} $, taxe ${taxPercent}%)`, inline: true },
        { name: "Pseudo Minecraft", value: minecraftPseudo, inline: true },
        ...(wApproveUrl ? [{ name: "Actions", value: `[✅ Marquer payé](${wApproveUrl})  ·  [❌ Refuser](${wRejectUrl})` }] : []),
      ],
    });
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
    "SELECT pseudo, created_at, referral_validated_at FROM accounts WHERE referred_by = ? ORDER BY created_at DESC",
    [req.user.id]
  );

  res.json({
    code: referralCode,
    bonusReferrer: REF_BONUS_REFERRER,
    bonusReferee: REF_BONUS_REFEREE,
    totalEarned: account.referral_earnings,
    count: referred.length,
    validatedCount: referred.filter(r => !!r.referral_validated_at).length,
    referred: referred.map(r => ({
      pseudo: r.pseudo,
      ts: new Date(r.created_at).getTime(),
      validated: !!r.referral_validated_at,
    })),
  });
});

/* ================= PARAMÈTRES : DÉPÔTS & RETRAITS (réglables depuis l'admin) ================= */
// Taux $ <-> 💎, taxe de retrait et pseudo à qui envoyer la commande /pay,
// stockés en base (table settings, clé/valeur) et gardés en cache mémoire.

const SETTINGS_DEFAULTS = {
  usdPerDiamond: 0.80,       // 1 💎 = X $
  withdrawTaxPercent: 10,    // taxe prélevée sur les retraits, en %
  depositPayPseudo: "totolabanane", // pseudo en jeu à qui envoyer /pay
  dailyBonusAmount: DAILY_BON, // montant du bonus quotidien, en 💎
  showBonusReminder: true,   // afficher ou non le rappel de bonus quotidien sur la page d'accueil
  startingBalance: START_BAL, // solde de départ offert à l'inscription, en 💎
  casinoEdgeMultiplier: 1.96, // rentabilité globale du casino : 1.96 = casino gagnant, 2.00 = neutre, 2.02 = joueurs gagnants
  featuredMarketId: null,    // id du marché mis en avant ("marché du jour") choisi manuellement par l'admin ; null = choix automatique (plus gros volume)
};

// Valeurs autorisées pour le curseur de rentabilité globale du casino (voir plus bas).
const CASINO_EDGE_OPTIONS = [1.96, 2.00, 2.02];
let appSettings = { ...SETTINGS_DEFAULTS };

async function loadSettings() {
  const [rows] = await pool.query("SELECT key, value FROM settings");
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  appSettings = {
    usdPerDiamond: map.usdPerDiamond != null && Number(map.usdPerDiamond) > 0 ? Number(map.usdPerDiamond) : SETTINGS_DEFAULTS.usdPerDiamond,
    withdrawTaxPercent: map.withdrawTaxPercent != null ? Number(map.withdrawTaxPercent) : SETTINGS_DEFAULTS.withdrawTaxPercent,
    depositPayPseudo: map.depositPayPseudo || SETTINGS_DEFAULTS.depositPayPseudo,
    dailyBonusAmount: map.dailyBonusAmount != null && Number(map.dailyBonusAmount) >= 0 ? Number(map.dailyBonusAmount) : SETTINGS_DEFAULTS.dailyBonusAmount,
    showBonusReminder: map.showBonusReminder != null ? map.showBonusReminder === "true" : SETTINGS_DEFAULTS.showBonusReminder,
    startingBalance: map.startingBalance != null && Number(map.startingBalance) >= 0 ? Number(map.startingBalance) : SETTINGS_DEFAULTS.startingBalance,
    casinoEdgeMultiplier: CASINO_EDGE_OPTIONS.includes(Number(map.casinoEdgeMultiplier)) ? Number(map.casinoEdgeMultiplier) : SETTINGS_DEFAULTS.casinoEdgeMultiplier,
    featuredMarketId: map.featuredMarketId || null,
  };
}

// Ratio appliqué aux marges maison des jeux "instant" (Flip, Dice, Mines,
// Chicken, Plinko) à partir du curseur de rentabilité globale : 2.00 = base
// de référence (comme aujourd'hui), 1.96 = marge maison renforcée d'~2%,
// 2.02 = marge maison réduite (le joueur devient légèrement favori).
function casinoEdgeRatio() { return appSettings.casinoEdgeMultiplier / 2.00; }
loadSettings().catch(e => console.error("Erreur chargement des paramètres :", e));

async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
     RETURNING key`,
    [key, String(value)]
  );
  await loadSettings();
}

// Vue complète envoyée au front (settings réglables + minimums fixés par .env).
function publicSettings() {
  return {
    ...appSettings,
    depositMinAmount: DEP_MIN,
    withdrawMinAmount: WD_MIN,
  };
}

function diamondsPerDollar() { return 1 / appSettings.usdPerDiamond; }
function usdToDiamonds(usd) { return Math.round((Number(usd) || 0) * diamondsPerDollar()); }
function diamondsToNetUsd(diamonds) {
  const gross = (Number(diamonds) || 0) * appSettings.usdPerDiamond;
  return Math.round(gross * (1 - appSettings.withdrawTaxPercent / 100) * 100) / 100;
}

app.get("/api/settings", authRequired, async (req, res) => {
  res.json(publicSettings());
});

app.get("/api/admin/settings", authRequired, adminRequired, async (req, res) => {
  res.json(publicSettings());
});

app.post("/api/admin/settings", authRequired, adminRequired, async (req, res) => {
  const { usdPerDiamond, withdrawTaxPercent, depositPayPseudo, dailyBonusAmount, showBonusReminder, startingBalance, casinoEdgeMultiplier, featuredMarketId } = req.body || {};

  if (usdPerDiamond !== undefined) {
    const v = Number(usdPerDiamond);
    if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: "Taux invalide (doit être un nombre > 0)." });
    await setSetting("usdPerDiamond", v);
  }
  if (withdrawTaxPercent !== undefined) {
    const v = Number(withdrawTaxPercent);
    if (!Number.isFinite(v) || v < 0 || v > 99) return res.status(400).json({ error: "Taxe invalide (entre 0 et 99)." });
    await setSetting("withdrawTaxPercent", v);
  }
  if (depositPayPseudo !== undefined) {
    const v = String(depositPayPseudo).trim();
    if (!v || v.length > 20) return res.status(400).json({ error: "Pseudo invalide (1 à 20 caractères)." });
    await setSetting("depositPayPseudo", v);
  }
  if (dailyBonusAmount !== undefined) {
    const v = Math.round(Number(dailyBonusAmount));
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: "Montant du bonus quotidien invalide (doit être un nombre ≥ 0)." });
    await setSetting("dailyBonusAmount", v);
  }
  if (showBonusReminder !== undefined) {
    await setSetting("showBonusReminder", showBonusReminder ? "true" : "false");
  }
  if (startingBalance !== undefined) {
    const v = Math.round(Number(startingBalance));
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: "Solde de départ invalide (doit être un nombre ≥ 0)." });
    await setSetting("startingBalance", v);
  }
  if (casinoEdgeMultiplier !== undefined) {
    const v = Number(casinoEdgeMultiplier);
    if (!CASINO_EDGE_OPTIONS.includes(v)) return res.status(400).json({ error: `Rentabilité invalide (valeurs autorisées : ${CASINO_EDGE_OPTIONS.join(", ")}).` });
    await setSetting("casinoEdgeMultiplier", v);
  }
  if (featuredMarketId !== undefined) {
    const v = String(featuredMarketId || "").trim();
    if (!v) {
      await setSetting("featuredMarketId", "");
    } else {
      const [rows] = await pool.query("SELECT id FROM markets WHERE id = ? AND status = 'open'", [v]);
      if (!rows[0]) return res.status(400).json({ error: "Marché introuvable ou non ouvert." });
      await setSetting("featuredMarketId", v);
    }
  }

  res.json(publicSettings());
});

/* ================= OFFRES DU MOMENT (réglables depuis l'admin) ================= */
// Trois types : "deposit_boost" (1er dépôt doublé, jusqu'à max_bonus 💎),
// "referral_boost" (montants de parrainage boostés) et "contest" (concours /
// tirage au sort avec un lot en 💎 stocké dans max_bonus et une date de fin
// qui sert de date du tirage). Le staff peut créer, activer/désactiver,
// changer la date de fin et supprimer des offres depuis l'admin. Une seule
// offre par type compte comme "active" côté logique métier : la plus
// récente parmi celles active=1 et non expirée.

function offerRowToJson(o) {
  const endsAt = o.ends_at || null;
  const expired = !!(endsAt && new Date(endsAt).getTime() <= Date.now());
  return {
    id: o.id,
    type: o.type,
    title: o.title || "",
    maxBonus: o.max_bonus != null ? Number(o.max_bonus) : null,
    referrerBonus: o.referrer_bonus != null ? Number(o.referrer_bonus) : null,
    refereeBonus: o.referee_bonus != null ? Number(o.referee_bonus) : null,
    minWager: o.min_wager != null ? Number(o.min_wager) : null,
    minWagerSince: o.min_wager_since || null,
    endsAt,
    active: !!o.active,
    expired,
    createdAt: o.created_at,
  };
}

// Total misé (marchés de prédiction + casino) par un joueur depuis une date
// donnée. Utilisé pour la condition de participation des concours ("il faut
// avoir misé au moins X 💎 depuis le DD/MM/AAAA"). Les mises remboursées
// (marché annulé) ne comptent pas.
async function getWageredSince(accountId, sinceDate) {
  const [[marketRow], [casinoRow]] = await Promise.all([
    pool.query(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM bets WHERE account_id = ? AND refunded = 0 AND created_at >= ?",
      [accountId, sinceDate]
    ),
    pool.query(
      "SELECT COALESCE(SUM(bet), 0) AS total FROM casino_bets WHERE account_id = ? AND created_at >= ?",
      [accountId, sinceDate]
    ),
  ]);
  return Number(marketRow[0].total || 0) + Number(casinoRow[0].total || 0);
}

// Renvoie l'offre active et non expirée la plus récente pour un type donné
// (ou null). Utilisée à la fois pour l'affichage public et pour la logique
// métier (doublement de dépôt, bonus de parrainage).
async function getActiveOffer(type) {
  const [rows] = await pool.query(
    `SELECT * FROM offers WHERE type = ? AND active = 1 AND (ends_at IS NULL OR ends_at > NOW()::timestamp)
     ORDER BY created_at DESC LIMIT 1`,
    [type]
  );
  return rows[0] || null;
}

app.get("/api/offers", authRequired, async (req, res) => {
  try {
    const [depositOffer, referralOffer, contestOffer] = await Promise.all([
      getActiveOffer("deposit_boost"),
      getActiveOffer("referral_boost"),
      getActiveOffer("contest"),
    ]);
    const offers = [depositOffer, referralOffer, contestOffer].filter(Boolean).map(offerRowToJson);

    // Pour un concours, on calcule l'éligibilité du joueur connecté (s'il y a
    // une condition de mise minimum), s'il a déjà rejoint, et le nombre total
    // de participants — tout ça pour l'affichage côté joueur.
    const contest = offers.find(o => o.type === "contest");
    if (contest) {
      if (contest.minWager != null) {
        const since = contest.minWagerSince || contest.createdAt;
        const wagered = await getWageredSince(req.user.id, since);
        contest.wageredAmount = wagered;
        contest.eligible = wagered >= contest.minWager;
      }
      const [[joinedRow], [countRow]] = await Promise.all([
        pool.query("SELECT 1 FROM contest_entries WHERE offer_id = ? AND account_id = ?", [contest.id, req.user.id]),
        pool.query("SELECT COUNT(*) AS n FROM contest_entries WHERE offer_id = ?", [contest.id]),
      ]);
      contest.joined = joinedRow.length > 0;
      contest.entryCount = Number(countRow[0].n || 0);
    }

    res.json(offers);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors du chargement des offres." });
  }
});

// Un joueur rejoint un concours. Bloqué si le concours n'est pas actif/est
// expiré, ou s'il ne remplit pas la condition de mise minimum (le cas
// échéant). Idempotent : rejoindre deux fois ne crée pas de doublon.
app.post("/api/offers/:id/join", authRequired, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM offers WHERE id = ?", [req.params.id]);
    const offer = rows[0];
    if (!offer || offer.type !== "contest") return res.status(404).json({ error: "Concours introuvable." });

    const o = offerRowToJson(offer);
    if (!o.active) return res.status(400).json({ error: "Ce concours n'est plus actif." });
    if (o.expired) return res.status(400).json({ error: "Ce concours est terminé." });

    if (o.minWager != null) {
      const since = o.minWagerSince || o.createdAt;
      const wagered = await getWageredSince(req.user.id, since);
      if (wagered < o.minWager) {
        return res.status(400).json({
          error: `Il te manque ${o.minWager - wagered} 💎 misés depuis le ${new Date(since).toLocaleDateString("fr-FR")} pour participer.`,
        });
      }
    }

    await pool.query(
      "INSERT INTO contest_entries (offer_id, account_id) VALUES (?, ?) ON CONFLICT (offer_id, account_id) DO NOTHING",
      [offer.id, req.user.id]
    );
    res.json({ ok: true, joined: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors de l'inscription au concours." });
  }
});

// Un joueur se retire d'un concours auquel il avait participé.
app.delete("/api/offers/:id/join", authRequired, async (req, res) => {
  try {
    await pool.query("DELETE FROM contest_entries WHERE offer_id = ? AND account_id = ?", [req.params.id, req.user.id]);
    res.json({ ok: true, joined: false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors du retrait du concours." });
  }
});

// Liste des participants d'un concours, pour que le staff puisse choisir le(s)
// gagnant(s) manuellement.
app.get("/api/admin/offers/:id/entries", authRequired, adminRequired, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ce.id, ce.created_at, a.id AS account_id, a.pseudo
       FROM contest_entries ce
       JOIN accounts a ON a.id = ce.account_id
       WHERE ce.offer_id = ?
       ORDER BY ce.created_at ASC`,
      [req.params.id]
    );
    res.json(rows.map(r => ({ id: r.id, accountId: r.account_id, pseudo: r.pseudo, joinedAt: r.created_at })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors du chargement des participants." });
  }
});

app.get("/api/admin/offers", authRequired, adminRequired, async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM offers ORDER BY created_at DESC");
    const offers = rows.map(offerRowToJson);
    const contestIds = offers.filter(o => o.type === "contest").map(o => o.id);
    if (contestIds.length > 0) {
      const [countRows] = await pool.query(
        `SELECT offer_id, COUNT(*) AS n FROM contest_entries WHERE offer_id IN (${contestIds.map(() => "?").join(",")}) GROUP BY offer_id`,
        contestIds
      );
      const countByOffer = Object.fromEntries(countRows.map(r => [r.offer_id, Number(r.n)]));
      offers.forEach(o => { if (o.type === "contest") o.entryCount = countByOffer[o.id] || 0; });
    }
    res.json(offers);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors du chargement des offres." });
  }
});

app.post("/api/admin/offers", authRequired, adminRequired, async (req, res) => {
  try {
    let { type, title, endsAt, maxBonus, referrerBonus, refereeBonus, minWager, minWagerSince } = req.body || {};
    type = String(type || "");
    if (!["deposit_boost", "referral_boost", "contest"].includes(type))
      return res.status(400).json({ error: "Type d'offre invalide." });

    title = title ? String(title).trim().slice(0, 140) : null;
    const endsAtVal = endsAt ? new Date(endsAt) : null;
    if (endsAt && (!endsAtVal || Number.isNaN(endsAtVal.getTime())))
      return res.status(400).json({ error: "Date de fin invalide." });

    let maxBonusVal = null, referrerBonusVal = null, refereeBonusVal = null;
    if (type === "deposit_boost" || type === "contest") {
      // pour "contest", max_bonus sert à stocker le nombre de 💎 à gagner
      maxBonusVal = Number(maxBonus);
      if (!Number.isFinite(maxBonusVal) || maxBonusVal <= 0)
        return res.status(400).json({ error: type === "contest" ? "Le nombre de 💎 à gagner est invalide (doit être un nombre > 0)." : "Bonus max invalide (doit être un nombre > 0)." });
    } else {
      referrerBonusVal = Number(referrerBonus);
      refereeBonusVal = Number(refereeBonus);
      if (!Number.isFinite(referrerBonusVal) || referrerBonusVal < 0 || !Number.isFinite(refereeBonusVal) || refereeBonusVal < 0)
        return res.status(400).json({ error: "Bonus parrain/filleul invalides (doivent être >= 0)." });
    }

    // Condition de mise minimum, uniquement pour les concours. Optionnelle :
    // si minWager est vide/0, le concours est ouvert à tout le monde.
    let minWagerVal = null, minWagerSinceVal = null;
    if (type === "contest") {
      if (minWager !== undefined && minWager !== null && String(minWager).trim() !== "") {
        minWagerVal = Number(minWager);
        if (!Number.isFinite(minWagerVal) || minWagerVal < 0)
          return res.status(400).json({ error: "Mise minimum invalide (doit être un nombre >= 0)." });
        if (minWagerVal > 0) {
          minWagerSinceVal = minWagerSince ? new Date(minWagerSince) : null;
          if (minWagerSince && (!minWagerSinceVal || Number.isNaN(minWagerSinceVal.getTime())))
            return res.status(400).json({ error: "Date de début de la mise minimum invalide." });
        } else {
          minWagerVal = null; // 0 = pas de condition
        }
      }
    }

    const [result] = await pool.query(
      `INSERT INTO offers (type, title, max_bonus, referrer_bonus, referee_bonus, min_wager, min_wager_since, ends_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      [type, title, maxBonusVal, referrerBonusVal, refereeBonusVal, minWagerVal, minWagerSinceVal, endsAtVal]
    );
    const [rows] = await pool.query("SELECT * FROM offers WHERE id = ?", [result.insertId]);
    res.json(offerRowToJson(rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors de la création de l'offre." });
  }
});

app.post("/api/admin/offers/:id", authRequired, adminRequired, async (req, res) => {
  try {
    const { active, endsAt, title, maxBonus, referrerBonus, refereeBonus, minWager, minWagerSince } = req.body || {};
    const [rows] = await pool.query("SELECT * FROM offers WHERE id = ?", [req.params.id]);
    const offer = rows[0];
    if (!offer) return res.status(404).json({ error: "Offre introuvable." });

    if (active !== undefined) {
      await pool.query("UPDATE offers SET active = ? WHERE id = ?", [active ? 1 : 0, offer.id]);
    }
    if (endsAt !== undefined) {
      const endsAtVal = endsAt ? new Date(endsAt) : null;
      if (endsAt && (!endsAtVal || Number.isNaN(endsAtVal.getTime())))
        return res.status(400).json({ error: "Date de fin invalide." });
      await pool.query("UPDATE offers SET ends_at = ? WHERE id = ?", [endsAtVal, offer.id]);
    }
    if (title !== undefined) {
      await pool.query("UPDATE offers SET title = ? WHERE id = ?", [title ? String(title).trim().slice(0, 140) : null, offer.id]);
    }
    if (maxBonus !== undefined) {
      const v = Number(maxBonus);
      if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ error: "Bonus max invalide." });
      await pool.query("UPDATE offers SET max_bonus = ? WHERE id = ?", [v, offer.id]);
    }
    if (referrerBonus !== undefined) {
      const v = Number(referrerBonus);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: "Bonus parrain invalide." });
      await pool.query("UPDATE offers SET referrer_bonus = ? WHERE id = ?", [v, offer.id]);
    }
    if (refereeBonus !== undefined) {
      const v = Number(refereeBonus);
      if (!Number.isFinite(v) || v < 0) return res.status(400).json({ error: "Bonus filleul invalide." });
      await pool.query("UPDATE offers SET referee_bonus = ? WHERE id = ?", [v, offer.id]);
    }
    // minWager: null/0/"" retire la condition de participation ; un nombre > 0
    // l'active (avec, éventuellement, une date de départ minWagerSince).
    if (minWager !== undefined) {
      const raw = String(minWager ?? "").trim();
      if (raw === "" || Number(raw) <= 0) {
        await pool.query("UPDATE offers SET min_wager = NULL, min_wager_since = NULL WHERE id = ?", [offer.id]);
      } else {
        const v = Number(raw);
        if (!Number.isFinite(v)) return res.status(400).json({ error: "Mise minimum invalide." });
        let sinceVal = null;
        if (minWagerSince) {
          sinceVal = new Date(minWagerSince);
          if (Number.isNaN(sinceVal.getTime())) return res.status(400).json({ error: "Date de début de la mise minimum invalide." });
        }
        await pool.query("UPDATE offers SET min_wager = ?, min_wager_since = ? WHERE id = ?", [v, sinceVal, offer.id]);
      }
    } else if (minWagerSince !== undefined) {
      const sinceVal = minWagerSince ? new Date(minWagerSince) : null;
      if (minWagerSince && Number.isNaN(sinceVal.getTime()))
        return res.status(400).json({ error: "Date de début de la mise minimum invalide." });
      await pool.query("UPDATE offers SET min_wager_since = ? WHERE id = ?", [sinceVal, offer.id]);
    }

    const [updated] = await pool.query("SELECT * FROM offers WHERE id = ?", [offer.id]);
    res.json(offerRowToJson(updated[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors de la mise à jour de l'offre." });
  }
});

app.delete("/api/admin/offers/:id", authRequired, adminRequired, async (req, res) => {
  const [result] = await pool.query("DELETE FROM offers WHERE id = ?", [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ error: "Offre introuvable." });
  res.json({ ok: true });
});

/* ================= CASINO : LIMITES DE MISE (réglables depuis l'admin) ================= */
// Chaque jeu a une mise min et (optionnellement) une mise max, stockées en
// base (table casino_limits) et gardées en cache mémoire pour ne pas requêter
// la DB à chaque mise. Le cache est rechargé après chaque modif admin.

const CASINO_GAMES_LIST = ["blackjack", "mines", "chicken", "flip", "dice", "unclaimfinder", "roulette", "slots", "aviator", "plinko"];
let casinoLimits = {}; // game -> { minBet, maxBet: number|null }

async function loadCasinoLimits() {
  const [rows] = await pool.query("SELECT game, min_bet, max_bet FROM casino_limits");
  const map = {};
  for (const r of rows) map[r.game] = { minBet: r.min_bet, maxBet: r.max_bet == null ? null : r.max_bet };
  for (const g of CASINO_GAMES_LIST) {
    if (!map[g]) map[g] = { minBet: 10, maxBet: null };
  }
  casinoLimits = map;
}
loadCasinoLimits().catch(e => console.error("Erreur chargement des limites de mise casino :", e));

function limitsFor(game) {
  return casinoLimits[game] || { minBet: 10, maxBet: null };
}

// Valide un montant de mise par rapport aux limites admin + solde du compte.
// Renvoie null si le montant est valide, sinon un message d'erreur prêt à
// être renvoyé tel quel au client.
function validateBetAmount(game, amount, balance) {
  const { minBet, maxBet } = limitsFor(game);
  if (!Number.isFinite(amount) || amount < minBet) {
    return `Mise invalide : minimum ${minBet} 💎.`;
  }
  if (maxBet != null && amount > maxBet) {
    return `Mise invalide : maximum ${maxBet} 💎 sur ce jeu.`;
  }
  if (amount > balance) {
    return `Mise invalide : tu n'as pas assez de solde.`;
  }
  return null;
}

/* ================= CASINO : PLINKO (aides) ================= */
// La table de multiplicateurs est calculée à partir de la loi binomiale :
// chaque bille traverse `rows` rangées de picots, avec à chaque rangée 50%
// de chances de partir à gauche ou à droite (comme un vrai plateau physique).
// La case d'arrivée `k` (0..rows) suit donc une loi binomiale(rows, 0.5).
// Les cases centrales (les plus probables) ont un petit multiplicateur, les
// cases extrêmes (les plus rares) un gros multiplicateur — exactement comme
// sur un vrai Plinko. Le paramètre "risque" ne change que l'écart entre le
// centre et les extrêmes ; la marge maison (3%) est appliquée en dernier en
// mettant à l'échelle toute la table pour que l'espérance de gain soit fixe.
const PLINKO_ROWS_OPTIONS = [8, 9, 10, 11, 12, 13, 14, 15, 16];
const PLINKO_RISK_EXPONENT = { low: 0.35, medium: 0.62, high: 1.0 };
const PLINKO_HOUSE_EDGE_BASE = 0.97; // 3% de marge maison de référence (à x2.00), ajustée par le curseur de rentabilité admin
function plinkoHouseEdge() { return PLINKO_HOUSE_EDGE_BASE * casinoEdgeRatio(); }

function plinkoBinomialCoeffs(rows) {
  const c = [1];
  for (let k = 1; k <= rows; k++) c.push((c[k - 1] * (rows - k + 1)) / k);
  return c; // C(rows, k) pour k = 0..rows
}

function plinkoMultiplierTable(rows, risk) {
  const combos = plinkoBinomialCoeffs(rows);
  const total = 2 ** rows;
  const probs = combos.map(c => c / total);
  const centerProb = rows % 2 === 0 ? probs[rows / 2] : (probs[(rows - 1) / 2] + probs[(rows + 1) / 2]) / 2;
  const exponent = PLINKO_RISK_EXPONENT[risk] || PLINKO_RISK_EXPONENT.medium;
  const raw = probs.map(p => (centerProb / p) ** exponent);
  const ev = raw.reduce((sum, m, k) => sum + m * probs[k], 0);
  const scale = plinkoHouseEdge() / ev;
  return raw.map(m => Math.max(0.1, Math.round(m * scale * 10) / 10));
}

function plinkoValidateRows(v) {
  const n = Math.round(Number(v));
  return PLINKO_ROWS_OPTIONS.includes(n) ? n : 14;
}
function plinkoValidateRisk(v) {
  return ["low", "medium", "high"].includes(v) ? v : "medium";
}

const plinkoHistory = new Map(); // accountId -> [{ bucket, rows, risk, multiplier, path, bet, payout, ts }, ...]

app.get("/api/casino/plinko/state", authRequired, (req, res) => {
  const history = plinkoHistory.get(req.user.id) || [];
  res.json({ last: history[0] || null, history });
});

app.get("/api/casino/plinko/table", authRequired, (req, res) => {
  const rows = plinkoValidateRows(req.query.rows || 14);
  const risk = plinkoValidateRisk(req.query.risk);
  res.json({ rows, risk, table: plinkoMultiplierTable(rows, risk) });
});

app.post("/api/casino/plinko/play", authRequired, async (req, res) => {
  try {
    if (CASINO_MAINTENANCE.plinko) {
      return res.status(503).json({ error: "Plinko est actuellement en maintenance. Réessaie un peu plus tard 🔧" });
    }
    const [arows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.user.id]);
    const account = arows[0];
    if (!account) return res.status(401).json({ error: "Compte introuvable." });

    const bet = Math.round(Number(req.body?.amount) || 0);
    const betErr = validateBetAmount("plinko", bet, account.balance);
    if (betErr) return res.status(400).json({ error: betErr });

    const rows = plinkoValidateRows(req.body?.rows);
    const risk = plinkoValidateRisk(req.body?.risk);

    await pool.query("UPDATE accounts SET balance = balance - ? WHERE id = ?", [bet, req.user.id]);
    await addWageringProgress(pool, req.user.id, bet);

    // Simule la chute de la bille : à chaque rangée, 50/50 gauche ou droite.
    const path = [];
    let bucket = 0;
    for (let i = 0; i < rows; i++) {
      const goRight = crypto.randomInt(2) === 1;
      if (goRight) bucket++;
      path.push(goRight ? 1 : 0);
    }

    const table = plinkoMultiplierTable(rows, risk);
    const multiplier = table[bucket];
    const payout = Math.round(bet * multiplier);
    if (payout > 0) {
      await pool.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [payout, req.user.id]);
    }

    const entry = { bucket, rows, risk, multiplier, path, bet, payout, ts: Date.now() };
    const list = [entry, ...(plinkoHistory.get(req.user.id) || [])].slice(0, 20);
    plinkoHistory.set(req.user.id, list);

    const net = payout - bet;
    await pool.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
      [req.user.pseudo, net >= 0 ? "yes" : "no", `🔴 Plinko — ${req.user.pseudo} : x${multiplier} (${net >= 0 ? "+" : ""}${net} 💎)`]
    );
    await pool.query(
      "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
      [req.user.id, "plinko", bet, payout, net >= 0 ? "win" : "lose", `${rows} lignes · risque ${risk} · case ${bucket} · x${multiplier}`]
    );

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({
      balance: after[0].balance,
      wageringRequired: after[0].wagering_required,
      wageringProgress: after[0].wagering_progress,
      bucket, rows, risk, multiplier, path, bet, payout, table, history: list,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

/* ================= CASINO : BLACKJACK ================= */
// Parties en cours stockées en mémoire (une seule partie active par compte à
// la fois) — pas besoin de table en base : le solde, lui, est débité/crédité
// en base à chaque étape qui compte (mise au lancement, gain à la
// résolution), donc un redémarrage du serveur ne peut jamais faire perdre ou
// gagner d'émeraudes injustement, au pire la partie en cours est à relancer.
const blackjackGames = new Map(); // accountId -> { deck, player, dealer, bet, doubled, status, result, payout }

const BJ_RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const BJ_SUITS = ["♠", "♥", "♦", "♣"];

function freshShuffledDeck() {
  const deck = [];
  for (const s of BJ_SUITS) for (const r of BJ_RANKS) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function bjCardValue(card) {
  if (card.r === "A") return 11;
  if (card.r === "K" || card.r === "Q" || card.r === "J") return 10;
  return Number(card.r);
}

function bjHandTotal(cards) {
  let total = 0;
  let acesAs11 = 0;
  for (const c of cards) {
    total += bjCardValue(c);
    if (c.r === "A") acesAs11++;
  }
  while (total > 21 && acesAs11 > 0) { total -= 10; acesAs11--; }
  return { total, soft: acesAs11 > 0 };
}

function bjIsBlackjack(cards) {
  return cards.length === 2 && bjHandTotal(cards).total === 21;
}

function bjCardJson(card, hidden) {
  return hidden ? { hidden: true } : { r: card.r, s: card.s };
}

function bjPublicState(game) {
  const finished = game.status === "finished";
  return {
    status: game.status,
    bet: game.bet,
    doubled: !!game.doubled,
    player: game.player.map(c => bjCardJson(c, false)),
    playerTotal: bjHandTotal(game.player).total,
    dealer: game.dealer.map((c, i) => bjCardJson(c, !finished && i === 1)),
    dealerTotal: finished ? bjHandTotal(game.dealer).total : null,
    result: game.result || null,
    payout: game.payout || 0,
  };
}

// Termine la partie : fait tirer le croupier si besoin (dealerPlays = false
// quand le joueur a déjà perdu d'office : dépassé 21, ou blackjack naturel
// où le croupier ne tire jamais de carte supplémentaire), compare les mains,
// crédite le gain éventuel et journalise le résultat dans le fil d'activité.
async function resolveBlackjack(req, game, dealerPlays) {
  if (dealerPlays) {
    let d = bjHandTotal(game.dealer);
    while (d.total < 17) {
      game.dealer.push(game.deck.pop());
      d = bjHandTotal(game.dealer);
    }
  }

  const p = bjHandTotal(game.player);
  const d = bjHandTotal(game.dealer);

  let result, payout;
  if (p.total > 21) {
    result = "lose"; payout = 0;
  } else if (bjIsBlackjack(game.player) && !game.doubled) {
    if (bjIsBlackjack(game.dealer)) { result = "push"; payout = game.bet; }
    else { result = "blackjack"; payout = Math.round(game.bet * 2.5); }
  } else if (d.total > 21 || p.total > d.total) {
    result = "win"; payout = game.bet * 2;
  } else if (p.total === d.total) {
    result = "push"; payout = game.bet;
  } else {
    result = "lose"; payout = 0;
  }

  game.status = "finished";
  game.result = result;
  game.payout = payout;

  if (payout > 0) {
    await pool.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [payout, req.user.id]);
  }

  const net = payout - game.bet;
  const resultLabel = { blackjack: "Blackjack ! 🂡", win: "Gagné", push: "Égalité", lose: "Perdu" }[result];
  const netLabel = net > 0 ? `+${net} 💎` : net < 0 ? `${net} 💎` : "±0 💎";
  await pool.query(
    "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
    [req.user.pseudo, net > 0 ? "yes" : net < 0 ? "no" : null, `🃏 Blackjack — ${req.user.pseudo} : ${resultLabel} (${netLabel})`]
  );
  await pool.query(
    "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
    [req.user.id, "blackjack", game.bet, payout, result, `${resultLabel} · joueur ${p.total} vs croupier ${d.total}${game.doubled ? " · doublé" : ""}`]
  );
}

app.get("/api/casino/blackjack/state", authRequired, (req, res) => {
  const game = blackjackGames.get(req.user.id);
  if (!game) return res.json({ active: false });
  res.json({ active: true, ...bjPublicState(game) });
});

app.post("/api/casino/blackjack/start", authRequired, async (req, res) => {
  try {
    const existing = blackjackGames.get(req.user.id);
    if (existing && existing.status === "playing") {
      return res.status(400).json({ error: "Termine ta partie de blackjack en cours." });
    }

    const [arows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.user.id]);
    const account = arows[0];
    if (!account) return res.status(401).json({ error: "Compte introuvable." });

    const bet = Math.round(Number(req.body?.amount) || 0);
    const betErr = validateBetAmount("blackjack", bet, account.balance);
    if (betErr) return res.status(400).json({ error: betErr });

    await pool.query("UPDATE accounts SET balance = balance - ? WHERE id = ?", [bet, req.user.id]);
    await addWageringProgress(pool, req.user.id, bet);

    const deck = freshShuffledDeck();
    const game = {
      deck,
      player: [deck.pop(), deck.pop()],
      dealer: [deck.pop(), deck.pop()],
      bet,
      doubled: false,
      status: "playing",
      result: null,
      payout: 0,
    };
    blackjackGames.set(req.user.id, game);

    if (bjIsBlackjack(game.player)) {
      await resolveBlackjack(req, game, false);
    }

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({ balance: after[0].balance, wageringRequired: after[0].wagering_required, wageringProgress: after[0].wagering_progress, ...bjPublicState(game) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors du lancement de la partie." });
  }
});

app.post("/api/casino/blackjack/hit", authRequired, async (req, res) => {
  try {
    const game = blackjackGames.get(req.user.id);
    if (!game || game.status !== "playing") return res.status(400).json({ error: "Aucune partie en cours." });

    game.player.push(game.deck.pop());
    const p = bjHandTotal(game.player);
    if (p.total > 21) {
      await resolveBlackjack(req, game, false);
    }

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({ balance: after[0].balance, wageringRequired: after[0].wagering_required, wageringProgress: after[0].wagering_progress, ...bjPublicState(game) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.post("/api/casino/blackjack/stand", authRequired, async (req, res) => {
  try {
    const game = blackjackGames.get(req.user.id);
    if (!game || game.status !== "playing") return res.status(400).json({ error: "Aucune partie en cours." });

    await resolveBlackjack(req, game, true);

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({ balance: after[0].balance, wageringRequired: after[0].wagering_required, wageringProgress: after[0].wagering_progress, ...bjPublicState(game) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.post("/api/casino/blackjack/double", authRequired, async (req, res) => {
  try {
    const game = blackjackGames.get(req.user.id);
    if (!game || game.status !== "playing") return res.status(400).json({ error: "Aucune partie en cours." });
    if (game.player.length !== 2) return res.status(400).json({ error: "Tu ne peux doubler qu'au tout premier coup." });

    const [arows] = await pool.query("SELECT balance FROM accounts WHERE id = ?", [req.user.id]);
    const balance = arows[0] ? arows[0].balance : 0;
    if (balance < game.bet) return res.status(400).json({ error: "Solde insuffisant pour doubler." });

    await pool.query("UPDATE accounts SET balance = balance - ? WHERE id = ?", [game.bet, req.user.id]);
    await addWageringProgress(pool, req.user.id, game.bet);
    game.bet *= 2;
    game.doubled = true;
    game.player.push(game.deck.pop());

    const p = bjHandTotal(game.player);
    await resolveBlackjack(req, game, p.total <= 21);

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({ balance: after[0].balance, wageringRequired: after[0].wagering_required, wageringProgress: after[0].wagering_progress, ...bjPublicState(game) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

/* ================= CASINO : STATUT / MAINTENANCE ================= */

// Active/désactive temporairement un jeu du casino sans rien déployer :
// passer un flag à `true` bloque les nouvelles mises (start / play) avec un
// message clair, sans toucher aux parties déjà en cours ni aux autres jeux.
const CASINO_MAINTENANCE = {
  blackjack: false,
  mines: true,
  flip: false,
  dice: false,
  unclaimfinder: false,
  roulette: false,
  chicken: false,
  slots: false,
  aviator: false,
  plinko: false,
};

app.get("/api/casino/status", authRequired, (req, res) => {
  res.json({ maintenance: CASINO_MAINTENANCE, limits: casinoLimits });
});

/* ================= CASINO : MINES ================= */

// Même logique que le blackjack ci-dessus : partie en mémoire (une seule à la
// fois par compte), mise débitée au lancement, gain crédité à la résolution
// (perte, victoire totale ou retrait). Les positions des mines ne sont
// JAMAIS envoyées au client tant que la partie est en cours — seule la liste
// des cases déjà révélées et le multiplicateur courant le sont.
const minesGames = new Map(); // accountId -> { mines: Set<number>, revealed: Set<number>, bet, minesCount, status, payout }

const MINES_GRID_SIZE = 25;
const MINES_HOUSE_EDGE_BASE = 0.92; // 8% de marge maison de référence (à x2.00), ajustée par le curseur de rentabilité admin
function minesHouseEdge() { return MINES_HOUSE_EDGE_BASE * casinoEdgeRatio(); }
const minesLocks = new Set(); // accountId en cours de traitement, anti double-reveal en parallèle

// Multiplicateur "juste" (sans marge) pour avoir révélé `revealedCount` cases
// sûres sachant qu'il y a `minesCount` mines parmi les MINES_GRID_SIZE cases :
// produit des probabilités inverses de tomber sur une case sûre à chaque tirage.
function minesFairMultiplier(minesCount, revealedCount) {
  let mult = 1;
  for (let i = 0; i < revealedCount; i++) {
    mult *= (MINES_GRID_SIZE - i) / (MINES_GRID_SIZE - minesCount - i);
  }
  return mult;
}
function minesMultiplier(minesCount, revealedCount) {
  if (revealedCount <= 0) return 1;
  return minesFairMultiplier(minesCount, revealedCount) * minesHouseEdge();
}

function minesPublicState(game) {
  const finished = game.status !== "playing";
  const revealedCount = game.revealed.size;
  const safeTiles = MINES_GRID_SIZE - game.minesCount;
  const nextMultiplier = revealedCount < safeTiles ? minesMultiplier(game.minesCount, revealedCount + 1) : null;
  return {
    status: game.status, // 'playing' | 'lost' | 'won' | 'cashed'
    bet: game.bet,
    minesCount: game.minesCount,
    revealed: Array.from(game.revealed),
    mines: finished ? Array.from(game.mines) : [],
    multiplier: minesMultiplier(game.minesCount, revealedCount),
    nextMultiplier,
    payout: game.payout || 0,
  };
}

app.get("/api/casino/mines/state", authRequired, (req, res) => {
  const game = minesGames.get(req.user.id);
  if (!game) return res.json({ active: false });
  res.json({ active: true, ...minesPublicState(game) });
});

app.post("/api/casino/mines/start", authRequired, async (req, res) => {
  try {
    if (CASINO_MAINTENANCE.mines) {
      return res.status(503).json({ error: "Mines est actuellement en maintenance. Réessaie un peu plus tard 🔧" });
    }
    const existing = minesGames.get(req.user.id);
    if (existing && existing.status === "playing") {
      return res.status(400).json({ error: "Termine ta partie de Mines en cours." });
    }

    const [arows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.user.id]);
    const account = arows[0];
    if (!account) return res.status(401).json({ error: "Compte introuvable." });

    const bet = Math.round(Number(req.body?.amount) || 0);
    const betErr = validateBetAmount("mines", bet, account.balance);
    if (betErr) return res.status(400).json({ error: betErr });
    const minesCount = clamp(Math.round(Number(req.body?.mines) || 3), 1, 24);

    await pool.query("UPDATE accounts SET balance = balance - ? WHERE id = ?", [bet, req.user.id]);
    await addWageringProgress(pool, req.user.id, bet);

    // tirage aléatoire des positions des mines parmi les 25 cases
    const positions = Array.from({ length: MINES_GRID_SIZE }, (_, i) => i);
    for (let i = positions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    const mines = new Set(positions.slice(0, minesCount));

    const game = { mines, revealed: new Set(), bet, minesCount, status: "playing", payout: 0 };
    minesGames.set(req.user.id, game);

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({ balance: after[0].balance, wageringRequired: after[0].wagering_required, wageringProgress: after[0].wagering_progress, ...minesPublicState(game) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors du lancement de la partie." });
  }
});

app.post("/api/casino/mines/reveal", authRequired, async (req, res) => {
  // Anti-course : si une requête reveal est déjà en train d'être traitée pour
  // ce compte (ex: plusieurs clics/requêtes envoyés en parallèle), on rejette
  // les suivantes plutôt que de laisser plusieurs cases se révéler "gratuitement"
  // avant que le statut "lost" n'ait eu le temps d'être posé.
  if (minesLocks.has(req.user.id)) {
    return res.status(429).json({ error: "Une case est déjà en cours de révélation." });
  }
  minesLocks.add(req.user.id);
  try {
    const game = minesGames.get(req.user.id);
    if (!game || game.status !== "playing") return res.status(400).json({ error: "Aucune partie en cours." });

    const tile = Math.round(Number(req.body?.tile));
    if (!Number.isInteger(tile) || tile < 0 || tile >= MINES_GRID_SIZE) {
      return res.status(400).json({ error: "Case invalide." });
    }
    if (game.revealed.has(tile)) return res.status(400).json({ error: "Case déjà révélée." });

    game.revealed.add(tile);

    if (game.mines.has(tile)) {
      game.status = "lost";
      game.payout = 0;
      await pool.query(
        "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
        [req.user.pseudo, "no", `💣 Mines — ${req.user.pseudo} a explosé (-${game.bet} 💎)`]
      );
      await pool.query(
        "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
        [req.user.id, "mines", game.bet, 0, "lose", `${game.minesCount} mines · explosé après ${game.revealed.size} case${game.revealed.size === 1 ? "" : "s"} révélée${game.revealed.size === 1 ? "" : "s"}`]
      );
    } else {
      const safeTiles = MINES_GRID_SIZE - game.minesCount;
      if (game.revealed.size === safeTiles) {
        // toutes les gemmes ont été trouvées : victoire automatique, encaissement immédiat
        game.status = "won";
        game.payout = Math.round(game.bet * minesMultiplier(game.minesCount, game.revealed.size));
        await pool.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [game.payout, req.user.id]);
        const net = game.payout - game.bet;
        await pool.query(
          "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
          [req.user.pseudo, "yes", `💎 Mines — ${req.user.pseudo} a trouvé toutes les gemmes ! (+${net} 💎)`]
        );
        await pool.query(
          "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
          [req.user.id, "mines", game.bet, game.payout, "win", `${game.minesCount} mines · toutes les gemmes trouvées`]
        );
      }
    }

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({ balance: after[0].balance, wageringRequired: after[0].wagering_required, wageringProgress: after[0].wagering_progress, ...minesPublicState(game) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  } finally {
    minesLocks.delete(req.user.id);
  }
});

app.post("/api/casino/mines/cashout", authRequired, async (req, res) => {
  try {
    const game = minesGames.get(req.user.id);
    if (!game || game.status !== "playing") return res.status(400).json({ error: "Aucune partie en cours." });
    if (game.revealed.size === 0) return res.status(400).json({ error: "Révèle au moins une case avant d'encaisser." });

    game.status = "cashed";
    game.payout = Math.round(game.bet * minesMultiplier(game.minesCount, game.revealed.size));
    await pool.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [game.payout, req.user.id]);

    const net = game.payout - game.bet;
    await pool.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
      [req.user.pseudo, net >= 0 ? "yes" : "no", `💎 Mines — ${req.user.pseudo} a encaissé (+${net} 💎)`]
    );
    await pool.query(
      "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
      [req.user.id, "mines", game.bet, game.payout, "cashout", `${game.minesCount} mines · encaissé après ${game.revealed.size} case${game.revealed.size === 1 ? "" : "s"} révélée${game.revealed.size === 1 ? "" : "s"}`]
    );

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({ balance: after[0].balance, wageringRequired: after[0].wagering_required, wageringProgress: after[0].wagering_progress, ...minesPublicState(game) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

/* ================= CASINO : CHICKEN ROAD ================= */

// Le poulet avance ligne par ligne sur la route ; chaque ligne franchie fait
// monter le multiplicateur, mais comporte un risque croissant de se faire
// renverser. Même logique en mémoire qu'aux Mines : une seule partie à la
// fois par compte, mise débitée au lancement, gain crédité à la résolution
// (percuté, toutes les lignes franchies, ou retrait manuel).
const chickenGames = new Map(); // accountId -> { bet, difficulty, step, status, payout }

const CHICKEN_HOUSE_EDGE_BASE = 0.97; // 3% de marge maison de référence (à x2.00), ajustée par le curseur de rentabilité admin
function chickenHouseEdge() { return CHICKEN_HOUSE_EDGE_BASE * casinoEdgeRatio(); }

// Chaque palier de difficulté définit : la probabilité de se faire renverser
// à la 1ère ligne (base), l'augmentation de cette probabilité à chaque ligne
// suivante (growth, la route devient plus dangereuse au fur et à mesure), et
// le nombre de lignes total avant la traversée complète (maxSteps).
// (valeurs doublées, ex: hardcore 25% -> 50%, pour un jeu plus corsé)
const CHICKEN_DIFFICULTIES = {
  facile:    { base: 0.10, growth: 0.008, maxSteps: 24 },
  moyen:     { base: 0.20, growth: 0.016, maxSteps: 18 },
  difficile: { base: 0.32, growth: 0.028, maxSteps: 12 },
  hardcore:  { base: 0.50, growth: 0.050, maxSteps: 8 },
};

// Probabilité de se faire renverser en tentant la ligne numéro `step` (1-indexé).
function chickenDeathProb(diff, step) {
  const p = diff.base + diff.growth * (step - 1);
  return clamp(p, 0.01, 0.75);
}

// Multiplicateur (avec marge maison) après avoir franchi `step` lignes sans encombre.
function chickenMultiplier(diffKey, step) {
  const diff = CHICKEN_DIFFICULTIES[diffKey];
  if (!diff || step <= 0) return 1;
  let mult = chickenHouseEdge();
  for (let i = 1; i <= step; i++) {
    mult *= 1 / (1 - chickenDeathProb(diff, i));
  }
  return mult;
}

function chickenPublicState(game) {
  const diff = CHICKEN_DIFFICULTIES[game.difficulty];
  const finished = game.status !== "playing";
  const nextMultiplier = game.step < diff.maxSteps ? chickenMultiplier(game.difficulty, game.step + 1) : null;
  // liste des multiplicateurs de chaque ligne, pour l'affichage de la route côté client
  const lanes = Array.from({ length: diff.maxSteps }, (_, i) => Number(chickenMultiplier(game.difficulty, i + 1).toFixed(2)));
  return {
    status: game.status, // 'playing' | 'lost' | 'won' | 'cashed'
    bet: game.bet,
    difficulty: game.difficulty,
    maxSteps: diff.maxSteps,
    step: game.step,
    lanes,
    multiplier: chickenMultiplier(game.difficulty, game.step),
    nextMultiplier,
    payout: game.payout || 0,
  };
}

app.get("/api/casino/chicken/state", authRequired, (req, res) => {
  const game = chickenGames.get(req.user.id);
  if (!game) return res.json({ active: false });
  res.json({ active: true, ...chickenPublicState(game) });
});

app.post("/api/casino/chicken/start", authRequired, async (req, res) => {
  try {
    if (CASINO_MAINTENANCE.chicken) {
      return res.status(503).json({ error: "Chicken Road est actuellement en maintenance. Réessaie un peu plus tard 🔧" });
    }
    const existing = chickenGames.get(req.user.id);
    if (existing && existing.status === "playing") {
      return res.status(400).json({ error: "Termine ta traversée de Chicken Road en cours." });
    }

    const [arows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.user.id]);
    const account = arows[0];
    if (!account) return res.status(401).json({ error: "Compte introuvable." });

    const bet = Math.round(Number(req.body?.amount) || 0);
    const betErr = validateBetAmount("chicken", bet, account.balance);
    if (betErr) return res.status(400).json({ error: betErr });
    const difficulty = ["facile", "moyen", "difficile", "hardcore"].includes(req.body?.difficulty) ? req.body.difficulty : "moyen";

    await pool.query("UPDATE accounts SET balance = balance - ? WHERE id = ?", [bet, req.user.id]);
    await addWageringProgress(pool, req.user.id, bet);

    const game = { bet, difficulty, step: 0, status: "playing", payout: 0 };
    chickenGames.set(req.user.id, game);

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({ balance: after[0].balance, wageringRequired: after[0].wagering_required, wageringProgress: after[0].wagering_progress, ...chickenPublicState(game) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur lors du lancement de la partie." });
  }
});

const chickenLocks = new Set(); // anti double-avance en parallèle, comme minesLocks

app.post("/api/casino/chicken/step", authRequired, async (req, res) => {
  if (chickenLocks.has(req.user.id)) {
    return res.status(429).json({ error: "Le poulet est déjà en train d'avancer." });
  }
  chickenLocks.add(req.user.id);
  try {
    const game = chickenGames.get(req.user.id);
    if (!game || game.status !== "playing") return res.status(400).json({ error: "Aucune traversée en cours." });

    const diff = CHICKEN_DIFFICULTIES[game.difficulty];
    const nextStep = game.step + 1;
    const p = chickenDeathProb(diff, nextStep);

    if (Math.random() < p) {
      game.status = "lost";
      game.payout = 0;
      await pool.query(
        "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
        [req.user.pseudo, "no", `🐔 Chicken Road — ${req.user.pseudo} s'est fait renverser (-${game.bet} 💎)`]
      );
      await pool.query(
        "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
        [req.user.id, "chicken", game.bet, 0, "lose", `${game.difficulty} · renversé à la ligne ${nextStep}`]
      );
    } else {
      game.step = nextStep;
      if (game.step >= diff.maxSteps) {
        // traversée complète : victoire automatique, encaissement immédiat
        game.status = "won";
        game.payout = Math.round(game.bet * chickenMultiplier(game.difficulty, game.step));
        await pool.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [game.payout, req.user.id]);
        const net = game.payout - game.bet;
        await pool.query(
          "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
          [req.user.pseudo, "yes", `🐔 Chicken Road — ${req.user.pseudo} a traversé toute la route ! (+${net} 💎)`]
        );
        await pool.query(
          "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
          [req.user.id, "chicken", game.bet, game.payout, "win", `${game.difficulty} · route entière traversée`]
        );
      }
    }

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({ balance: after[0].balance, wageringRequired: after[0].wagering_required, wageringProgress: after[0].wagering_progress, ...chickenPublicState(game) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  } finally {
    chickenLocks.delete(req.user.id);
  }
});

app.post("/api/casino/chicken/cashout", authRequired, async (req, res) => {
  try {
    const game = chickenGames.get(req.user.id);
    if (!game || game.status !== "playing") return res.status(400).json({ error: "Aucune traversée en cours." });
    if (game.step === 0) return res.status(400).json({ error: "Avance d'au moins une ligne avant d'encaisser." });

    game.status = "cashed";
    game.payout = Math.round(game.bet * chickenMultiplier(game.difficulty, game.step));
    await pool.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [game.payout, req.user.id]);

    const net = game.payout - game.bet;
    await pool.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
      [req.user.pseudo, net >= 0 ? "yes" : "no", `🐔 Chicken Road — ${req.user.pseudo} a encaissé (+${net} 💎)`]
    );
    await pool.query(
      "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
      [req.user.id, "chicken", game.bet, game.payout, "cashout", `${game.difficulty} · encaissé après ${game.step} ligne${game.step === 1 ? "" : "s"}`]
    );

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({ balance: after[0].balance, wageringRequired: after[0].wagering_required, wageringProgress: after[0].wagering_progress, ...chickenPublicState(game) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

/* ================= CASINO : FLIP ================= */

// Jeu à pièce : contrairement au blackjack/mines, chaque partie est un seul
// lancer résolu instantanément (pas de partie "en cours" à conserver). On
// garde juste en mémoire, par compte, le petit historique des derniers
// lancers pour l'affichage côté client (le plus récent en tête).
const flipHistory = new Map(); // accountId -> [{ result, win, bet, payout, ts }, ...]

// Multiplicateur de gain sur Flip (jeu 50/50) : c'est exactement le curseur
// de rentabilité globale réglé dans le panel admin (1.96 / 2.00 / 2.02).
function flipMultiplier() { return appSettings.casinoEdgeMultiplier; }

app.get("/api/casino/flip/state", authRequired, (req, res) => {
  const history = flipHistory.get(req.user.id) || [];
  res.json({ last: history[0] || null, history });
});

app.post("/api/casino/flip/play", authRequired, async (req, res) => {
  try {
    const [arows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.user.id]);
    const account = arows[0];
    if (!account) return res.status(401).json({ error: "Compte introuvable." });

    const bet = Math.round(Number(req.body?.amount) || 0);
    const betErr = validateBetAmount("flip", bet, account.balance);
    if (betErr) return res.status(400).json({ error: betErr });
    const side = req.body?.side === "pile" ? "pile" : "face";

    await pool.query("UPDATE accounts SET balance = balance - ? WHERE id = ?", [bet, req.user.id]);
    await addWageringProgress(pool, req.user.id, bet);

    const result = Math.random() < 0.5 ? "face" : "pile";
    const win = result === side;
    const payout = win ? Math.round(bet * flipMultiplier()) : 0;
    if (payout > 0) {
      await pool.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [payout, req.user.id]);
    }

    const entry = { result, win, bet, payout, ts: Date.now() };
    const list = [entry, ...(flipHistory.get(req.user.id) || [])].slice(0, 20);
    flipHistory.set(req.user.id, list);

    const net = payout - bet;
    await pool.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
      [req.user.pseudo, net >= 0 ? "yes" : "no", `🪙 Flip — ${req.user.pseudo} : ${result === "face" ? "Face" : "Pile"} (${net >= 0 ? "+" : ""}${net} 💎)`]
    );
    await pool.query(
      "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
      [req.user.id, "flip", bet, payout, win ? "win" : "lose", `Misé sur ${side === "pile" ? "Pile" : "Face"} · résultat ${result === "pile" ? "Pile" : "Face"}`]
    );

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({
      balance: after[0].balance,
      wageringRequired: after[0].wagering_required,
      wageringProgress: after[0].wagering_progress,
      result, win, bet, payout, history: list,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

/* ================= CASINO : DICE ================= */

// Dice classique : le joueur choisit une cible (2 à 98) et parie que le tirage
// tombera EN DESSOUS (under) ou AU DESSUS (over) de cette cible. Le tirage est
// un nombre à deux décimales entre 0.00 et 99.99 (uniforme). La chance de
// gagner découle directement de la cible et du sens choisi, et le
// multiplicateur est calculé pour garder la même marge maison que Flip
// (~1% : 99 / winChance, comme 99/50 = 1.98x sur une pièce 50/50).
const diceHistory = new Map(); // accountId -> [{ target, direction, roll, win, multiplier, bet, payout, ts }, ...]

// Même marge que Flip, généralisée : à winChance=50 on retrouve
// flipMultiplier() (ex: 99/50 = 1.98 comme avant), suit donc le même curseur.
function diceHouseEdge() { return flipMultiplier() * 50; }
const DICE_TARGET_MIN = 2;
const DICE_TARGET_MAX = 98;

function diceValidateTarget(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 50;
  return clamp(n, DICE_TARGET_MIN, DICE_TARGET_MAX);
}
function diceValidateDirection(v) {
  return v === "over" ? "over" : "under";
}
function diceWinChance(target, direction) {
  return direction === "under" ? target : 100 - target;
}
function diceMultiplier(target, direction) {
  const winChance = diceWinChance(target, direction);
  return Math.round((diceHouseEdge() / winChance) * 100) / 100;
}

app.get("/api/casino/dice/state", authRequired, (req, res) => {
  const history = diceHistory.get(req.user.id) || [];
  res.json({ last: history[0] || null, history });
});

app.get("/api/casino/dice/table", authRequired, (req, res) => {
  const target = diceValidateTarget(req.query.target);
  const direction = diceValidateDirection(req.query.direction);
  res.json({ target, direction, winChance: diceWinChance(target, direction), multiplier: diceMultiplier(target, direction) });
});

app.post("/api/casino/dice/play", authRequired, async (req, res) => {
  try {
    if (CASINO_MAINTENANCE.dice) {
      return res.status(503).json({ error: "Dice est actuellement en maintenance. Réessaie un peu plus tard 🔧" });
    }
    const [arows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.user.id]);
    const account = arows[0];
    if (!account) return res.status(401).json({ error: "Compte introuvable." });

    const bet = Math.round(Number(req.body?.amount) || 0);
    const betErr = validateBetAmount("dice", bet, account.balance);
    if (betErr) return res.status(400).json({ error: betErr });

    const target = diceValidateTarget(req.body?.target);
    const direction = diceValidateDirection(req.body?.direction);
    const multiplier = diceMultiplier(target, direction);

    await pool.query("UPDATE accounts SET balance = balance - ? WHERE id = ?", [bet, req.user.id]);
    await addWageringProgress(pool, req.user.id, bet);

    // Tirage uniforme à deux décimales entre 0.00 et 99.99, généré via une
    // source cryptographique sûre (pas de Math.random pour l'issue du jeu).
    const roll = crypto.randomInt(0, 10000) / 100;
    const win = direction === "under" ? roll < target : roll > target;
    const payout = win ? Math.round(bet * multiplier) : 0;
    if (payout > 0) {
      await pool.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [payout, req.user.id]);
    }

    const entry = { target, direction, roll, win, multiplier, bet, payout, ts: Date.now() };
    const list = [entry, ...(diceHistory.get(req.user.id) || [])].slice(0, 20);
    diceHistory.set(req.user.id, list);

    const net = payout - bet;
    await pool.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
      [req.user.pseudo, net >= 0 ? "yes" : "no", `🎲 Dice — ${req.user.pseudo} : ${roll.toFixed(2)} (${net >= 0 ? "+" : ""}${net} 💎)`]
    );
    await pool.query(
      "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
      [req.user.id, "dice", bet, payout, win ? "win" : "lose", `${direction === "under" ? "Sous" : "Au-dessus de"} ${target} · tirage ${roll.toFixed(2)} · x${multiplier}`]
    );

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({
      balance: after[0].balance,
      wageringRequired: after[0].wagering_required,
      wageringProgress: after[0].wagering_progress,
      target, direction, roll, win, multiplier, bet, payout, history: list,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

/* ================= CASINO : UNCLAIM FINDER ================= */

// Mini-jeu Paladium : le joueur choisit un Unclaim Finder (vert / jaune /
// rouge). Le serveur tire un pourcentage aléatoire pour chacun des trois ;
// celui qui obtient le plus gros pourcentage l'emporte (à l'affichage, ces
// pourcentages sont arrondis à l'entier, mais le tirage lui-même garde 2
// décimales en interne pour départager les cas quasi-égaux).
//
// Le gain n'est plus un x3 "brut" fixe : c'est un x2.95 de base, avec un
// bonus/malus selon le pourcentage du gagnant (celui-ci = le pourcentage du
// joueur quand il gagne, puisqu'il faut avoir choisi le bon Finder) :
//   - pourcentage gagnant < 25%  → malus, x2
//   - pourcentage gagnant > 95%  → bonus, x4
//   - sinon (25%–95%)            → x2.95 (le cas normal, ~1/3 de chance)
const UNCLAIMFINDER_BASE_MULTIPLIER = 2.95;
const UNCLAIMFINDER_LOW_MULTIPLIER = 2;
const UNCLAIMFINDER_HIGH_MULTIPLIER = 4;
const UNCLAIMFINDER_LOW_THRESHOLD = 25; // strictement en dessous
const UNCLAIMFINDER_HIGH_THRESHOLD = 95; // strictement au dessus
const UNCLAIMFINDER_COLORS = ["vert", "jaune", "rouge"];
const unclaimFinderHistory = new Map(); // accountId -> [{ percentages, winner, choice, win, bet, payout, multiplier, ts }, ...]

function ufRollPercentage() {
  return Math.round(crypto.randomInt(100, 10000) / 100 * 100) / 100; // 1.00 → 99.99
}

// Tire les 3 pourcentages et désigne le plus haut comme gagnant. En cas
// d'égalité parfaite (très rare, tirage à 2 décimales), on ne retire QUE les
// couleurs ex-aequo jusqu'à ce qu'une seule ressorte en tête — pour ne pas
// avantager systématiquement une couleur par rapport à une autre.
function ufRollAndPickWinner() {
  const percentages = {};
  for (const c of UNCLAIMFINDER_COLORS) percentages[c] = ufRollPercentage();
  let best = Math.max(...UNCLAIMFINDER_COLORS.map(c => percentages[c]));
  let tied = UNCLAIMFINDER_COLORS.filter(c => percentages[c] === best);
  while (tied.length > 1) {
    for (const c of tied) percentages[c] = ufRollPercentage();
    best = Math.max(...UNCLAIMFINDER_COLORS.map(c => percentages[c]));
    tied = UNCLAIMFINDER_COLORS.filter(c => percentages[c] === best);
  }
  return { percentages, winner: tied[0] };
}

// Le bonus/malus est calculé sur le pourcentage ARRONDI du gagnant, pour que
// ce que le joueur voit à l'écran corresponde exactement au multiplicateur
// appliqué (pas de décimale cachée qui change la tranche en coulisses).
function ufMultiplierFor(winnerPercentRounded) {
  if (winnerPercentRounded < UNCLAIMFINDER_LOW_THRESHOLD) return UNCLAIMFINDER_LOW_MULTIPLIER;
  if (winnerPercentRounded > UNCLAIMFINDER_HIGH_THRESHOLD) return UNCLAIMFINDER_HIGH_MULTIPLIER;
  return UNCLAIMFINDER_BASE_MULTIPLIER;
}

app.get("/api/casino/unclaimfinder/state", authRequired, (req, res) => {
  const history = unclaimFinderHistory.get(req.user.id) || [];
  res.json({ last: history[0] || null, history });
});

app.post("/api/casino/unclaimfinder/play", authRequired, async (req, res) => {
  try {
    if (CASINO_MAINTENANCE.unclaimfinder) {
      return res.status(503).json({ error: "Unclaim Finder est en maintenance, réessaie plus tard." });
    }
    const [arows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.user.id]);
    const account = arows[0];
    if (!account) return res.status(401).json({ error: "Compte introuvable." });

    const bet = Math.round(Number(req.body?.amount) || 0);
    const betErr = validateBetAmount("unclaimfinder", bet, account.balance);
    if (betErr) return res.status(400).json({ error: betErr });
    const choice = UNCLAIMFINDER_COLORS.includes(req.body?.choice) ? req.body.choice : "vert";

    await pool.query("UPDATE accounts SET balance = balance - ? WHERE id = ?", [bet, req.user.id]);
    await addWageringProgress(pool, req.user.id, bet);

    // Un pourcentage indépendant par Unclaim Finder ; le plus haut gagne.
    const { percentages, winner } = ufRollAndPickWinner();
    const win = choice === winner;
    const winnerPercentRounded = Math.round(percentages[winner]);
    const multiplier = ufMultiplierFor(winnerPercentRounded);
    const payout = win ? Math.round(bet * multiplier) : 0;
    if (payout > 0) {
      await pool.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [payout, req.user.id]);
    }

    // Pourcentages arrondis pour l'affichage (et pour tout ce qu'on renvoie/stocke) ;
    // le tirage brut à 2 décimales n'a servi qu'à départager en interne.
    const percentagesRounded = {};
    for (const c of UNCLAIMFINDER_COLORS) percentagesRounded[c] = Math.round(percentages[c]);

    const entry = { percentages: percentagesRounded, winner, choice, win, bet, payout, multiplier, ts: Date.now() };
    const list = [entry, ...(unclaimFinderHistory.get(req.user.id) || [])].slice(0, 20);
    unclaimFinderHistory.set(req.user.id, list);

    const net = payout - bet;
    await pool.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
      [req.user.pseudo, net >= 0 ? "yes" : "no", `🔎 Unclaim Finder — ${req.user.pseudo} : ${winner} gagnant (${net >= 0 ? "+" : ""}${net} 💎)`]
    );
    await pool.query(
      "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
      [req.user.id, "unclaimfinder", bet, payout, win ? "win" : "lose", `Choisi ${choice} · gagnant ${winner} (${winnerPercentRounded}%, x${multiplier})`]
    );

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({
      balance: after[0].balance,
      wageringRequired: after[0].wagering_required,
      wageringProgress: after[0].wagering_progress,
      percentages: percentagesRounded, winner, choice, win, bet, payout, multiplier, history: list,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

/* ================= CASINO : ROULETTE ================= */

// Roulette européenne classique (37 cases, 0 unique). Comme Flip, chaque
// partie est un seul lancer résolu instantanément côté serveur — mais on
// accepte ici plusieurs mises simultanées (numéro plein, rouge/noir,
// pair/impair, manque/passe, douzaines, colonnes), comme sur une vraie
// table. Les gains suivent les cotes réelles de la roulette (aucune marge
// supplémentaire n'est appliquée : la présence du 0 suffit à donner
// l'avantage à la maison, exactement comme dans un vrai casino).
const rouletteHistory = new Map(); // accountId -> [{ pocket, color, ts, net }, ...]

const ROULETTE_MAX_BETS = 12; // nombre max de mises différentes sur un même lancer
const ROULETTE_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

function rouletteColor(pocket) {
  if (pocket === 0) return "green";
  return ROULETTE_RED.has(pocket) ? "red" : "black";
}

// Multiplicateur total (mise comprise) selon le type de pari.
const ROULETTE_PAYOUTS = {
  straight: 36, // numéro plein, paie 35 pour 1
  red: 2, black: 2, even: 2, odd: 2, low: 2, high: 2, // chances simples, paient 1 pour 1
  dozen: 3, column: 3, // douzaines/colonnes, paient 2 pour 1
};

function rouletteBetWins(bet, pocket) {
  switch (bet.type) {
    case "straight": return pocket === bet.value;
    case "red": return pocket !== 0 && ROULETTE_RED.has(pocket);
    case "black": return pocket !== 0 && !ROULETTE_RED.has(pocket);
    case "even": return pocket !== 0 && pocket % 2 === 0;
    case "odd": return pocket !== 0 && pocket % 2 === 1;
    case "low": return pocket >= 1 && pocket <= 18;
    case "high": return pocket >= 19 && pocket <= 36;
    case "dozen": return pocket !== 0 && Math.ceil(pocket / 12) === bet.value;
    case "column": return pocket !== 0 && (((pocket - 1) % 3) + 1) === bet.value;
    default: return false;
  }
}

function rouletteBetLabel(bet) {
  switch (bet.type) {
    case "straight": return `Numéro plein ${bet.value}`;
    case "red": return "Rouge";
    case "black": return "Noir";
    case "even": return "Pair";
    case "odd": return "Impair";
    case "low": return "Manque (1-18)";
    case "high": return "Passe (19-36)";
    case "dozen": return bet.value === 1 ? "1ère douzaine (1-12)" : bet.value === 2 ? "2ème douzaine (13-24)" : "3ème douzaine (25-36)";
    case "column": return `Colonne ${bet.value}`;
    default: return "Pari";
  }
}

// Valide et normalise la liste de mises envoyée par le client. Renvoie
// `null` si un pari est invalide (type/valeur incohérents ou montant hors
// bornes) pour que l'appelant rejette toute la requête d'un bloc.
function rouletteValidateBets(rawBets, balance) {
  if (!Array.isArray(rawBets) || rawBets.length === 0 || rawBets.length > ROULETTE_MAX_BETS) return null;
  const { minBet, maxBet } = limitsFor("roulette");
  const bets = [];
  let total = 0;
  for (const raw of rawBets) {
    const type = raw?.type;
    const amount = Math.round(Number(raw?.amount) || 0);
    if (amount < minBet || (maxBet != null && amount > maxBet)) return null;
    let value = null;
    if (type === "straight") {
      value = Math.round(Number(raw?.value));
      if (!Number.isInteger(value) || value < 0 || value > 36) return null;
    } else if (type === "dozen" || type === "column") {
      value = Math.round(Number(raw?.value));
      if (![1, 2, 3].includes(value)) return null;
    } else if (!["red", "black", "even", "odd", "low", "high"].includes(type)) {
      return null;
    }
    total += amount;
    bets.push({ type, value, amount });
  }
  if (total > balance) return null;
  return { bets, total };
}

app.get("/api/casino/roulette/state", authRequired, (req, res) => {
  res.json({ history: rouletteHistory.get(req.user.id) || [] });
});

app.post("/api/casino/roulette/play", authRequired, async (req, res) => {
  try {
    if (CASINO_MAINTENANCE.roulette) {
      return res.status(503).json({ error: "Roulette est actuellement en maintenance. Réessaie un peu plus tard 🔧" });
    }

    const [arows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.user.id]);
    const account = arows[0];
    if (!account) return res.status(401).json({ error: "Compte introuvable." });

    const validated = rouletteValidateBets(req.body?.bets, account.balance);
    if (!validated) {
      const { minBet, maxBet } = limitsFor("roulette");
      const maxMsg = maxBet != null ? ` (max ${maxBet} 💎 par mise)` : "";
      return res.status(400).json({ error: `Mises invalides : chaque mise doit être entre ${minBet} 💎${maxMsg} et le total ne peut pas dépasser ton solde.` });
    }
    const { bets, total } = validated;

    await pool.query("UPDATE accounts SET balance = balance - ? WHERE id = ?", [total, req.user.id]);
    await addWageringProgress(pool, req.user.id, total);

    const pocket = Math.floor(Math.random() * 37); // 0 à 36
    const color = rouletteColor(pocket);

    let totalPayout = 0;
    const resolvedBets = bets.map(bet => {
      const win = rouletteBetWins(bet, pocket);
      const payout = win ? bet.amount * ROULETTE_PAYOUTS[bet.type] : 0;
      totalPayout += payout;
      return { ...bet, win, payout, label: rouletteBetLabel(bet) };
    });

    if (totalPayout > 0) {
      await pool.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [totalPayout, req.user.id]);
    }

    const net = totalPayout - total;
    const entry = { pocket, color, net, ts: Date.now() };
    const list = [entry, ...(rouletteHistory.get(req.user.id) || [])].slice(0, 30);
    rouletteHistory.set(req.user.id, list);

    await pool.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
      [req.user.pseudo, net >= 0 ? "yes" : "no", `🎡 Roulette — ${req.user.pseudo} : ${pocket} ${color === "red" ? "🔴" : color === "black" ? "⚫" : "🟢"} (${net >= 0 ? "+" : ""}${net} 💎)`]
    );
    await pool.query(
      "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
      [req.user.id, "roulette", total, totalPayout, net >= 0 ? "win" : "lose", `Bille sur ${pocket} (${color}) · ${bets.length} mise${bets.length === 1 ? "" : "s"}`]
    );

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({
      balance: after[0].balance,
      wageringRequired: after[0].wagering_required,
      wageringProgress: after[0].wagering_progress,
      pocket, color, bets: resolvedBets, totalBet: total, totalPayout, net,
      history: list,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

/* ================= CASINO : SLOTS ================= */

// Machine à sous à 3 rouleaux / 1 ligne de paiement. Comme Flip et Roulette,
// chaque partie est un seul tirage résolu instantanément côté serveur — pas
// de partie "en cours" à conserver, juste un petit historique en mémoire par
// compte pour l'affichage côté client (le plus récent en tête).
const slotsHistory = new Map(); // accountId -> [{ reels, win, kind, multiplier, bet, payout, ts }, ...]


// Symboles pondérés (poids sur 100) + table de gains :
//  - "triple" : multiplicateur si les 3 rouleaux affichent le même symbole
//  - "pair"   : multiplicateur si exactement 2 des 3 rouleaux matchent
//               (seulement pour les symboles "fruits", comme sur une vraie
//               machine à sous — les symboles rares ne paient qu'au triple)
// Poids élevé = symbole fréquent = petit gain ; poids faible = symbole rare
// = gros gain. Réglé pour un RTP théorique d'environ 95% (léger avantage
// maison, comme un vrai bandit-manchot).
const SLOTS_SYMBOLS = [
  { id: "cherry",  emoji: "🍒", weight: 34, triple: 3,   pair: 1.2 },
  { id: "lemon",   emoji: "🍋", weight: 24, triple: 5,   pair: 1.75 },
  { id: "grape",   emoji: "🍇", weight: 17, triple: 9,   pair: 2.25 },
  { id: "bell",    emoji: "🔔", weight: 13, triple: 17,  pair: 0 },
  { id: "star",    emoji: "⭐", weight: 8,  triple: 33,  pair: 0 },
  { id: "diamond", emoji: "💎", weight: 3,  triple: 68,  pair: 0 },
  { id: "seven",   emoji: "7️⃣", weight: 1,  triple: 225, pair: 0 },
];
const SLOTS_TOTAL_WEIGHT = SLOTS_SYMBOLS.reduce((s, x) => s + x.weight, 0);
const slotsSymbolById = id => SLOTS_SYMBOLS.find(s => s.id === id);

function spinSlotReel() {
  let r = Math.random() * SLOTS_TOTAL_WEIGHT;
  for (const sym of SLOTS_SYMBOLS) {
    if (r < sym.weight) return sym.id;
    r -= sym.weight;
  }
  return SLOTS_SYMBOLS[0].id;
}

// Détermine le gain d'un tirage [a, b, c]. Triple d'abord, sinon la
// meilleure paire éligible parmi les 3 combinaisons de 2 rouleaux.
function resolveSlotsSpin(reels) {
  const [a, b, c] = reels;
  if (a === b && b === c) {
    return { multiplier: slotsSymbolById(a).triple, kind: "triple", matchSymbol: a };
  }
  let best = 0, matchSymbol = null;
  for (const [x, y] of [[a, b], [b, c], [a, c]]) {
    if (x === y) {
      const m = slotsSymbolById(x).pair || 0;
      if (m > best) { best = m; matchSymbol = x; }
    }
  }
  if (best > 0) return { multiplier: best, kind: "pair", matchSymbol };
  return { multiplier: 0, kind: "none", matchSymbol: null };
}

app.get("/api/casino/slots/state", authRequired, (req, res) => {
  const history = slotsHistory.get(req.user.id) || [];
  res.json({ last: history[0] || null, history });
});

app.post("/api/casino/slots/play", authRequired, async (req, res) => {
  try {
    if (CASINO_MAINTENANCE.slots) {
      return res.status(503).json({ error: "Slots est actuellement en maintenance. Réessaie un peu plus tard 🔧" });
    }
    const [arows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.user.id]);
    const account = arows[0];
    if (!account) return res.status(401).json({ error: "Compte introuvable." });

    const bet = Math.round(Number(req.body?.amount) || 0);
    const betErr = validateBetAmount("slots", bet, account.balance);
    if (betErr) return res.status(400).json({ error: betErr });

    await pool.query("UPDATE accounts SET balance = balance - ? WHERE id = ?", [bet, req.user.id]);
    await addWageringProgress(pool, req.user.id, bet);

    const reels = [spinSlotReel(), spinSlotReel(), spinSlotReel()];
    const { multiplier, kind, matchSymbol } = resolveSlotsSpin(reels);
    const win = multiplier > 0;
    const payout = win ? Math.round(bet * multiplier) : 0;
    if (payout > 0) {
      await pool.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [payout, req.user.id]);
    }

    const entry = { reels, win, kind, multiplier, bet, payout, ts: Date.now() };
    const list = [entry, ...(slotsHistory.get(req.user.id) || [])].slice(0, 20);
    slotsHistory.set(req.user.id, list);

    const net = payout - bet;
    const detailLabel = kind === "triple" ? `Triple ${matchSymbol}` : kind === "pair" ? `Paire ${matchSymbol}` : "Aucune combinaison";
    await pool.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
      [req.user.pseudo, net >= 0 ? "yes" : "no", `🎰 Slots — ${req.user.pseudo} : ${detailLabel} (${net >= 0 ? "+" : ""}${net} 💎)`]
    );
    await pool.query(
      "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
      [req.user.id, "slots", bet, payout, win ? "win" : "lose", `${reels.join(" · ")} · ${detailLabel}`]
    );

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({
      balance: after[0].balance,
      wageringRequired: after[0].wagering_required,
      wageringProgress: after[0].wagering_progress,
      reels, win, kind, multiplier, bet, payout, history: list,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

/* ================= CASINO : AVIATOR ================= */

// Jeu à "manche partagée" : contrairement aux autres jeux du casino (une
// partie privée par joueur), Aviator tourne comme une seule table pour tout
// le site — tous les joueurs connectés voient le même avion, le même
// multiplicateur et misent sur la même manche en même temps.
//
// Cycle de la manche, entièrement piloté par le serveur (boucle en mémoire,
// tick toutes les 100ms) :
//   1. "waiting" (mises ouvertes, AVIATOR_WAITING_MS)
//   2. "flying"  (le multiplicateur grimpe, retrait possible à tout moment)
//   3. "crashed" (résultat affiché, AVIATOR_CRASHED_MS)
//   -> retour à 1.
//
// Le point de crash est tiré au moment où la manche démarre mais n'est
// JAMAIS envoyé au client avant que l'avion n'explose réellement (sinon un
// joueur inspectant les requêtes réseau pourrait connaître le résultat à
// l'avance et encaisser juste avant à coup sûr). Le client ne reçoit que le
// multiplicateur courant, recalculé indépendamment côté serveur.

const AVIATOR_WAITING_MS = 7000; // durée de la phase de mise
const AVIATOR_CRASHED_MS = 4000; // durée d'affichage du résultat avant la manche suivante
// Vitesse de montée du multiplicateur : m(t) = e^(K*t), t en secondes.
// Avec ce K, le multiplicateur double environ toutes les 6 secondes de vol.
const AVIATOR_GROWTH_K = Math.log(2) / 6;
const AVIATOR_TICK_MS = 100;
const AVIATOR_MAX_MULTIPLIER = 100; // plafond de la manche : l'avion "explose" automatiquement à ce multiplicateur s'il l'atteint — modifie juste ce chiffre si tu veux un plafond différent
const AVIATOR_MAX_MULTIPLIER_CENTS = AVIATOR_MAX_MULTIPLIER * 100;

// Tirage du point de crash (en centièmes, ex: 250 = 2.50x), via une table de
// points de contrôle : chaque ligne dit "il y a f% de chances que le crash
// arrive à m× ou moins". Ça permet de régler chaque tranche indépendamment
// (ex: souvent jusqu'à x1.5, mais rarement au-delà de x2), ce qu'une simple
// courbe à un seul paramètre ne peut pas faire. Pour ajuster le jeu, modifie
// juste les valeurs `f` ci-dessous (chacune doit rester entre la précédente
// et la suivante, et la dernière doit valoir 1).
const AVIATOR_CDF_ANCHORS = [
  { m: 100,                        f: 0.20 }, // 20% de crash pile à 1.00x
  { m: 130,                        f: 0.35 }, // 35% de chances de crasher à 1.30x ou moins
  { m: 150,                        f: 0.50 },
  { m: 200,                        f: 0.75 }, // -> 25% de chances d'atteindre x2 ou plus
  { m: 300,                        f: 0.82 }, // -> 18% de chances d'atteindre x3 ou plus
  { m: 500,                        f: 0.90 }, // -> 10% de chances d'atteindre x5 ou plus
  { m: AVIATOR_MAX_MULTIPLIER_CENTS, f: 1.00 },
];

function aviatorRollCrash() {
  const r = crypto.randomInt(1, 1_000_000) / 1_000_000; // r dans (0, 1]
  if (r <= AVIATOR_CDF_ANCHORS[0].f) return AVIATOR_CDF_ANCHORS[0].m;
  for (let i = 1; i < AVIATOR_CDF_ANCHORS.length; i++) {
    const prev = AVIATOR_CDF_ANCHORS[i - 1];
    const cur = AVIATOR_CDF_ANCHORS[i];
    if (r <= cur.f) {
      const frac = (r - prev.f) / (cur.f - prev.f);
      // interpolation en échelle logarithmique, adaptée aux multiplicateurs
      const logM = Math.log(prev.m) + frac * (Math.log(cur.m) - Math.log(prev.m));
      return clamp(Math.round(Math.exp(logM)), prev.m + 1, AVIATOR_MAX_MULTIPLIER_CENTS);
    }
  }
  return AVIATOR_MAX_MULTIPLIER_CENTS;
}

let aviatorRound = {
  id: 0,
  phase: "waiting", // "waiting" | "flying" | "crashed"
  phaseEndsAt: Date.now() + AVIATOR_WAITING_MS,
  flightStartedAt: null,
  crashAt: null,
  crashPoint: null, // en centièmes, tenu secret tant que phase !== "crashed"
  bets: new Map(), // accountId -> { pseudo, amount, autoCashout|null, cashedOutAt|null, payout }
};
const aviatorHistory = []; // multiplicateurs de crash récents (centièmes), les plus récents en tête
const aviatorLocks = new Set(); // accountId en cours de traitement (anti double-requête)

function aviatorCurrentMultiplier() {
  if (aviatorRound.phase !== "flying" || !aviatorRound.flightStartedAt) return 100;
  const elapsedSec = (Date.now() - aviatorRound.flightStartedAt) / 1000;
  const m = Math.floor(Math.exp(AVIATOR_GROWTH_K * elapsedSec) * 100);
  return Math.min(m, aviatorRound.crashPoint || AVIATOR_MAX_MULTIPLIER_CENTS);
}

function aviatorStartWaiting() {
  aviatorRound = {
    id: aviatorRound.id + 1,
    phase: "waiting",
    phaseEndsAt: Date.now() + AVIATOR_WAITING_MS,
    flightStartedAt: null,
    crashAt: null,
    crashPoint: null,
    bets: new Map(),
  };
}

function aviatorStartFlying() {
  aviatorRound.phase = "flying";
  aviatorRound.crashPoint = aviatorRollCrash();
  aviatorRound.flightStartedAt = Date.now();
  const flightSeconds = Math.log(aviatorRound.crashPoint / 100) / AVIATOR_GROWTH_K;
  aviatorRound.crashAt = aviatorRound.flightStartedAt + Math.max(150, flightSeconds * 1000);
}

async function aviatorDoCashout(accountId, bet, multiplierCents) {
  bet.cashedOutAt = multiplierCents;
  bet.payout = Math.round((bet.amount * multiplierCents) / 100);
  await pool.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [bet.payout, accountId]);
  const net = bet.payout - bet.amount;
  await pool.query(
    "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
    [bet.pseudo, "yes", `✈️ Aviator — ${bet.pseudo} a encaissé à ${(multiplierCents / 100).toFixed(2)}x (+${net} 💎)`]
  );
  await pool.query(
    "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
    [accountId, "aviator", bet.amount, bet.payout, "cashout", `Encaissé à ${(multiplierCents / 100).toFixed(2)}x`]
  );
}

async function aviatorCrash() {
  const losers = [];
  for (const [accountId, bet] of aviatorRound.bets) {
    if (bet.cashedOutAt == null) losers.push([accountId, bet]);
  }
  aviatorRound.phase = "crashed";
  aviatorRound.phaseEndsAt = Date.now() + AVIATOR_CRASHED_MS;
  aviatorHistory.unshift(aviatorRound.crashPoint);
  if (aviatorHistory.length > 30) aviatorHistory.length = 30;

  for (const [accountId, bet] of losers) {
    await pool.query(
      "INSERT INTO casino_bets (account_id, game, bet, payout, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
      [accountId, "aviator", bet.amount, 0, "lose", `Crash à ${(aviatorRound.crashPoint / 100).toFixed(2)}x`]
    );
  }
  if (losers.length > 0) {
    await pool.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
      [losers[0][1].pseudo, "no", `✈️ Aviator — Crash à ${(aviatorRound.crashPoint / 100).toFixed(2)}x (${losers.length} joueur${losers.length === 1 ? "" : "s"} n'${losers.length === 1 ? "a" : "ont"} pas encaissé)`]
    );
  }
}

async function aviatorTick() {
  try {
    const now = Date.now();
    if (aviatorRound.phase === "waiting" && now >= aviatorRound.phaseEndsAt) {
      aviatorStartFlying();
    } else if (aviatorRound.phase === "flying") {
      const current = aviatorCurrentMultiplier();
      for (const [accountId, bet] of aviatorRound.bets) {
        if (bet.cashedOutAt == null && bet.autoCashout && bet.autoCashout <= current && bet.autoCashout < aviatorRound.crashPoint) {
          await aviatorDoCashout(accountId, bet, bet.autoCashout);
        }
      }
      if (now >= aviatorRound.crashAt) {
        await aviatorCrash();
      }
    } else if (aviatorRound.phase === "crashed" && now >= aviatorRound.phaseEndsAt) {
      aviatorStartWaiting();
    }
  } catch (e) {
    console.error("Erreur boucle Aviator :", e);
  }
}
setInterval(aviatorTick, AVIATOR_TICK_MS);

function aviatorPublicBets() {
  return Array.from(aviatorRound.bets.values())
    .map(b => ({ pseudo: b.pseudo, amount: b.amount, cashedOutAt: b.cashedOutAt, payout: b.payout || 0 }))
    .sort((a, b) => b.amount - a.amount);
}

function aviatorStateFor(accountId) {
  const myBet = aviatorRound.bets.get(accountId) || null;
  return {
    phase: aviatorRound.phase,
    roundId: aviatorRound.id,
    multiplier: aviatorCurrentMultiplier(),
    phaseEndsAt: aviatorRound.phaseEndsAt,
    flightStartedAt: aviatorRound.flightStartedAt,
    crashPoint: aviatorRound.phase === "crashed" ? aviatorRound.crashPoint : null,
    bets: aviatorPublicBets(),
    history: aviatorHistory,
    myBet: myBet
      ? { amount: myBet.amount, autoCashout: myBet.autoCashout, cashedOutAt: myBet.cashedOutAt, payout: myBet.payout || 0 }
      : null,
  };
}

app.get("/api/casino/aviator/state", authRequired, (req, res) => {
  res.json(aviatorStateFor(req.user.id));
});

app.post("/api/casino/aviator/bet", authRequired, async (req, res) => {
  if (aviatorLocks.has(req.user.id)) return res.status(429).json({ error: "Requête déjà en cours." });
  aviatorLocks.add(req.user.id);
  try {
    if (CASINO_MAINTENANCE.aviator) {
      return res.status(503).json({ error: "Aviator est actuellement en maintenance. Réessaie un peu plus tard 🔧" });
    }
    if (aviatorRound.phase !== "waiting") {
      return res.status(400).json({ error: "Les mises sont fermées, attends la prochaine manche." });
    }
    if (aviatorRound.bets.has(req.user.id)) {
      return res.status(400).json({ error: "Tu as déjà misé sur cette manche." });
    }

    const [arows] = await pool.query("SELECT balance FROM accounts WHERE id = ?", [req.user.id]);
    const account = arows[0];
    if (!account) return res.status(401).json({ error: "Compte introuvable." });

    const amount = Math.round(Number(req.body?.amount) || 0);
    const betErr = validateBetAmount("aviator", amount, account.balance);
    if (betErr) return res.status(400).json({ error: betErr });
    let autoCashout = req.body?.autoCashout != null ? Math.round(Number(req.body.autoCashout) * 100) : null;
    if (!Number.isFinite(autoCashout) || autoCashout < 101) autoCashout = null;

    await pool.query("UPDATE accounts SET balance = balance - ? WHERE id = ?", [amount, req.user.id]);

    // La manche peut avoir démarré pendant cet appel (await ci-dessus) : on
    // revérifie juste avant d'enregistrer la mise, et on rembourse sinon.
    if (aviatorRound.phase !== "waiting" || aviatorRound.bets.has(req.user.id)) {
      await pool.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [amount, req.user.id]);
      return res.status(400).json({ error: "Manche déjà lancée, réessaie à la prochaine." });
    }

    await addWageringProgress(pool, req.user.id, amount);
    aviatorRound.bets.set(req.user.id, { pseudo: req.user.pseudo, amount, autoCashout, cashedOutAt: null, payout: 0 });

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({
      balance: after[0].balance,
      wageringRequired: after[0].wagering_required,
      wageringProgress: after[0].wagering_progress,
      ...aviatorStateFor(req.user.id),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  } finally {
    aviatorLocks.delete(req.user.id);
  }
});

app.post("/api/casino/aviator/cashout", authRequired, async (req, res) => {
  if (aviatorLocks.has(req.user.id)) return res.status(429).json({ error: "Requête déjà en cours." });
  aviatorLocks.add(req.user.id);
  try {
    if (aviatorRound.phase !== "flying") return res.status(400).json({ error: "Impossible d'encaisser maintenant." });
    const bet = aviatorRound.bets.get(req.user.id);
    if (!bet) return res.status(400).json({ error: "Tu n'as pas de mise sur cette manche." });
    if (bet.cashedOutAt != null) return res.status(400).json({ error: "Déjà encaissé." });

    const current = aviatorCurrentMultiplier();
    if (current >= aviatorRound.crashPoint) return res.status(400).json({ error: "Trop tard, l'avion a explosé." });

    await aviatorDoCashout(req.user.id, bet, current);

    const [after] = await pool.query("SELECT balance, wagering_required, wagering_progress FROM accounts WHERE id = ?", [req.user.id]);
    res.json({
      balance: after[0].balance,
      wageringRequired: after[0].wagering_required,
      wageringProgress: after[0].wagering_progress,
      ...aviatorStateFor(req.user.id),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erreur serveur." });
  } finally {
    aviatorLocks.delete(req.user.id);
  }
});

/* ================= ADMIN : JOUEURS ================= */

app.get("/api/admin/accounts", authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query(`
    SELECT
      a.id, a.pseudo, a.balance, a.is_admin, a.created_at,
      a.referral_code, a.referral_earnings, a.referral_validated_at,
      a.wagering_required, a.wagering_progress,
      ref.pseudo AS referred_by_pseudo,
      COALESCE(bs.bet_count, 0) AS bet_count,
      COALESCE(bs.total_wagered, 0) AS total_wagered,
      COALESCE(cs.casino_bet_count, 0) AS casino_bet_count,
      COALESCE(cs.casino_total_wagered, 0) AS casino_total_wagered,
      COALESCE(cs.casino_net, 0) AS casino_net
    FROM accounts a
    LEFT JOIN accounts ref ON ref.id = a.referred_by
    LEFT JOIN (
      SELECT account_id, COUNT(*) AS bet_count, SUM(amount) AS total_wagered
      FROM bets GROUP BY account_id
    ) bs ON bs.account_id = a.id
    LEFT JOIN (
      SELECT account_id, COUNT(*) AS casino_bet_count, SUM(bet) AS casino_total_wagered, SUM(payout - bet) AS casino_net
      FROM casino_bets GROUP BY account_id
    ) cs ON cs.account_id = a.id
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
    referralValidated: a.referred_by_pseudo ? !!a.referral_validated_at : null,
    wageringRequired: a.wagering_required,
    wageringProgress: a.wagering_progress,
    betCount: a.bet_count,
    totalWagered: a.total_wagered,
    casinoBetCount: a.casino_bet_count,
    casinoTotalWagered: a.casino_total_wagered,
    casinoNet: a.casino_net,
  })));
});

// Permet au staff de modifier directement le solde d'un joueur : soit en
// fixant un nouveau montant absolu ("balance"), soit en appliquant un
// ajustement relatif ("delta", positif ou négatif).
app.post("/api/admin/accounts/:id/balance", authRequired, adminRequired, async (req, res) => {
  const accountId = Number(req.params.id);
  const { balance, delta, reason } = req.body || {};

  const [rows] = await pool.query("SELECT id, pseudo, balance FROM accounts WHERE id = ?", [accountId]);
  const account = rows[0];
  if (!account) return res.status(404).json({ error: "Joueur introuvable." });

  let newBalance;
  if (balance !== undefined && balance !== null && String(balance).trim() !== "") {
    newBalance = Math.round(Number(balance));
  } else if (delta !== undefined && delta !== null && String(delta).trim() !== "") {
    newBalance = account.balance + Math.round(Number(delta));
  } else {
    return res.status(400).json({ error: "Indique un nouveau solde (balance) ou un ajustement (delta)." });
  }

  if (!Number.isFinite(newBalance) || newBalance < 0) {
    return res.status(400).json({ error: "Le solde doit être un nombre positif ou nul." });
  }

  await pool.query("UPDATE accounts SET balance = ? WHERE id = ?", [newBalance, accountId]);

  const diff = newBalance - account.balance;
  await pool.query(
    "INSERT INTO feed (pseudo, side, amount, title) VALUES (?, ?, 0, ?)",
    [account.pseudo, diff >= 0 ? "yes" : "no", `🛠️ Ajustement staff — ${account.pseudo} : ${diff >= 0 ? "+" : ""}${diff} 💎${reason ? ` (${String(reason).trim().slice(0, 120)})` : ""}`]
  );

  res.json({ ok: true, id: accountId, balance: newBalance });
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
    refunded: !!b.refunded,
    marketStatus: b.market_status,
    marketResolution: b.market_resolution,
    ts: new Date(b.created_at).getTime(),
  })));
});

app.get("/api/admin/accounts/:id/casino-bets", authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT * FROM casino_bets WHERE account_id = ? ORDER BY created_at DESC LIMIT 200`,
    [req.params.id]
  );
  res.json(rows.map(c => ({
    id: c.id,
    game: c.game,
    bet: c.bet,
    payout: c.payout,
    net: c.payout - c.bet,
    result: c.result,
    detail: c.detail,
    ts: new Date(c.created_at).getTime(),
  })));
});

// Liste des filleuls d'un joueur (vue admin) : qui il a parrainé, et si
// chaque parrainage a été validé (1er dépôt approuvé) ou est encore en attente.
app.get("/api/admin/accounts/:id/referrals", authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT pseudo, created_at, referral_validated_at, referral_bonus_referee
     FROM accounts WHERE referred_by = ? ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json(rows.map(r => ({
    pseudo: r.pseudo,
    ts: new Date(r.created_at).getTime(),
    validated: !!r.referral_validated_at,
    refereeBonus: r.referral_bonus_referee,
  })));
});

// Vue d'ensemble : toutes les parties casino de tous les joueurs, les plus
// récentes en premier (pratique pour surveiller l'activité casino sans avoir
// à ouvrir chaque joueur un par un).
app.get("/api/admin/casino-bets", authRequired, adminRequired, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT c.*, a.pseudo FROM casino_bets c
     JOIN accounts a ON a.id = c.account_id
     ORDER BY c.created_at DESC LIMIT 300`
  );
  res.json(rows.map(c => ({
    id: c.id,
    accountId: c.account_id,
    pseudo: c.pseudo,
    game: c.game,
    bet: c.bet,
    payout: c.payout,
    net: c.payout - c.bet,
    result: c.result,
    detail: c.detail,
    ts: new Date(c.created_at).getTime(),
  })));
});

app.get("/api/admin/casino-limits", authRequired, adminRequired, (req, res) => {
  res.json(casinoLimits);
});

app.post("/api/admin/casino-limits", authRequired, adminRequired, async (req, res) => {
  const { game } = req.body || {};
  if (!CASINO_GAMES_LIST.includes(game)) {
    return res.status(400).json({ error: "Jeu inconnu." });
  }
  const minBet = Math.round(Number(req.body?.minBet));
  if (!Number.isFinite(minBet) || minBet < 1) {
    return res.status(400).json({ error: "Mise minimum invalide (doit être un nombre >= 1)." });
  }
  let maxBet = req.body?.maxBet;
  if (maxBet === null || maxBet === "" || maxBet === undefined) {
    maxBet = null;
  } else {
    maxBet = Math.round(Number(maxBet));
    if (!Number.isFinite(maxBet) || maxBet < minBet) {
      return res.status(400).json({ error: "Mise maximum invalide (doit être >= mise minimum, ou vide pour aucun plafond)." });
    }
  }

  await pool.query(
    `INSERT INTO casino_limits (game, min_bet, max_bet) VALUES (?, ?, ?)
     ON CONFLICT (game) DO UPDATE SET min_bet = EXCLUDED.min_bet, max_bet = EXCLUDED.max_bet
     RETURNING game`,
    [game, minBet, maxBet]
  );
  await loadCasinoLimits();
  res.json(casinoLimits);
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
  if (appSettings.featuredMarketId === req.params.id) await setSetting("featuredMarketId", "");
  res.json({ ok: true });
});

// Verrouille un marché : plus aucune nouvelle mise n'est acceptée, mais il
// n'est pas encore résolu (utile pour figer les paris avant l'issue d'un
// événement, le temps de vérifier le résultat).
app.post("/api/admin/markets/:id/lock", authRequired, adminRequired, async (req, res) => {
  const [result] = await pool.query(
    "UPDATE markets SET status = 'locked' WHERE id = ? AND status = 'open'",
    [req.params.id]
  );
  if (!result.affectedRows) return res.status(400).json({ error: "Ce marché n'est pas ouvert." });
  res.json({ ok: true });
});

// Rouvre un marché verrouillé (les joueurs peuvent de nouveau parier).
app.post("/api/admin/markets/:id/unlock", authRequired, adminRequired, async (req, res) => {
  const [result] = await pool.query(
    "UPDATE markets SET status = 'open' WHERE id = ? AND status = 'locked'",
    [req.params.id]
  );
  if (!result.affectedRows) return res.status(400).json({ error: "Ce marché n'est pas verrouillé." });
  res.json({ ok: true });
});

// Modifie manuellement le % de chance affiché (ex: pour recaler le marché
// après une nouvelle information, indépendamment des mises déjà placées).
app.post("/api/admin/markets/:id/pct", authRequired, adminRequired, async (req, res) => {
  const { yes } = req.body || {};
  const yesPct = clamp(Math.round(Number(yes)), 2, 98);
  if (!Number.isFinite(yesPct)) return res.status(400).json({ error: "Pourcentage invalide." });
  const [result] = await pool.query(
    "UPDATE markets SET yes_pct = ? WHERE id = ? AND status != 'resolved'",
    [yesPct, req.params.id]
  );
  if (!result.affectedRows) return res.status(400).json({ error: "Marché introuvable ou déjà résolu." });
  res.json({ ok: true, yes: yesPct });
});

// Convertit une date JS en chaîne "YYYY-MM-DD HH:MM:SS" (UTC), le même format
// que celui produit par SQLite pour bets.created_at (colonnes DEFAULT
// datetime('now')), afin de pouvoir comparer les deux par simple égalité/
// comparaison de chaînes.
function toSqliteUtc(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

app.post("/api/admin/markets/:id/resolve", authRequired, adminRequired, async (req, res) => {
  const { outcome, resolvedAt } = req.body || {};
  if (outcome !== "yes" && outcome !== "no") return res.status(400).json({ error: "Résultat invalide." });

  // Heure de fin du marché : celle envoyée par le staff (pré-remplie à
  // "maintenant" côté interface, mais modifiable), sinon l'heure actuelle
  // par défaut si rien n'est fourni.
  let cutoffDate = resolvedAt ? new Date(resolvedAt) : new Date();
  if (isNaN(cutoffDate.getTime())) cutoffDate = new Date();
  const cutoff = toSqliteUtc(cutoffDate);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [mrows] = await conn.query("SELECT * FROM markets WHERE id = ? FOR UPDATE", [req.params.id]);
    const market = mrows[0];
    if (!market || market.status === "resolved") {
      await conn.rollback();
      return res.status(400).json({ error: "Marché introuvable ou déjà résolu." });
    }

    const [allBets] = await conn.query("SELECT * FROM bets WHERE market_id = ?", [req.params.id]);
    let paidCount = 0;
    let refundedCount = 0;
    for (const b of allBets) {
      // Un pari placé après l'heure de fin réelle du marché n'a pas pu être
      // pris en compte dans l'issue : il est simplement remboursé (mise
      // rendue), sans gain ni perte, quel que soit le côté choisi.
      if (b.created_at > cutoff) {
        await conn.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [b.amount, b.account_id]);
        await conn.query("UPDATE bets SET refunded = 1 WHERE id = ?", [b.id]);
        refundedCount++;
      } else if (b.side === outcome) {
        const payout = Math.round((b.amount * 100) / Math.max(2, b.price));
        await conn.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [payout, b.account_id]);
        paidCount++;
      }
    }

    await conn.query(
      "UPDATE markets SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ?",
      [outcome, cutoff, req.params.id]
    );
    await conn.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES ('Staff', ?, 0, ?)",
      [outcome, `🏁 Résultat — ${market.title} : ${outcome === "yes" ? "Oui" : "Non"}`]
    );

    await conn.commit();
    if (appSettings.featuredMarketId === req.params.id) await setSetting("featuredMarketId", "");
    res.json({ paid: paidCount, refunded: refundedCount });
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

// (referralValidated / referrerPseudo / referrerBonusGiven / refereeBonusGiven
// sont renvoyés par approveDeposit() en plus de amount/bonus/pseudo, pour que
// les points d'entrée appelants — panel admin et lien Discord — puissent
// mentionner un parrainage tout juste validé.)
async function approveDeposit(depositId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [drows] = await conn.query("SELECT * FROM deposits WHERE id = ? FOR UPDATE", [depositId]);
    const dep = drows[0];
    if (!dep || dep.status !== "pending") {
      await conn.rollback();
      return { ok: false, error: "Ce dépôt n'est plus en attente." };
    }

    // Offre "1er dépôt doublé" active ? On regarde si le joueur a déjà un
    // dépôt approuvé avant celui-ci — si non, c'est son tout premier, et le
    // bonus (plafonné à max_bonus) est ajouté automatiquement, sans action
    // manuelle du staff.
    const [priorApproved] = await conn.query(
      "SELECT COUNT(*) AS n FROM deposits WHERE account_id = ? AND status = 'approved'",
      [dep.account_id]
    );
    const isFirstDeposit = Number(priorApproved[0].n) === 0;
    const depositOffer = isFirstDeposit ? await getActiveOffer("deposit_boost") : null;
    const bonus = depositOffer ? Math.min(dep.amount, Number(depositOffer.max_bonus)) : 0;
    const totalCredit = dep.amount + bonus;

    await conn.query(
      "UPDATE accounts SET balance = balance + ?, wagering_required = wagering_required + ? WHERE id = ?",
      [totalCredit, dep.amount, dep.account_id]
    );
    await conn.query("UPDATE deposits SET status = 'approved', reviewed_at = NOW() WHERE id = ?", [dep.id]);

    const [arows] = await conn.query(
      "SELECT pseudo, referred_by, referral_bonus_referrer, referral_bonus_referee, referral_validated_at FROM accounts WHERE id = ?",
      [dep.account_id]
    );
    const acc = arows[0] || {};
    const pseudo = acc.pseudo || "?";

    // Parrainage : validé au tout premier dépôt approuvé du filleul (et une
    // seule fois — referral_validated_at sert de garde-fou). Le parrain et
    // le filleul touchent alors chacun le bonus verrouillé à l'inscription.
    let referralValidated = false;
    let referrerPseudo = null;
    let referrerBonusGiven = 0;
    let refereeBonusGiven = 0;
    if (isFirstDeposit && acc.referred_by && !acc.referral_validated_at) {
      referrerBonusGiven = Number(acc.referral_bonus_referrer) || 0;
      refereeBonusGiven = Number(acc.referral_bonus_referee) || 0;

      await conn.query("UPDATE accounts SET referral_validated_at = NOW() WHERE id = ?", [dep.account_id]);
      if (refereeBonusGiven > 0) {
        await conn.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [refereeBonusGiven, dep.account_id]);
      }
      const [rrows] = await conn.query("SELECT pseudo FROM accounts WHERE id = ?", [acc.referred_by]);
      referrerPseudo = rrows[0] ? rrows[0].pseudo : null;
      if (referrerBonusGiven > 0) {
        await conn.query(
          "UPDATE accounts SET balance = balance + ?, referral_earnings = referral_earnings + ? WHERE id = ?",
          [referrerBonusGiven, referrerBonusGiven, acc.referred_by]
        );
      }
      referralValidated = true;
    }

    const feedLines = [
      bonus > 0
        ? `🏦 Dépôt validé pour ${pseudo} : +${dep.amount} 💎 + 🎁 ${bonus} 💎 offerts (1er dépôt doublé)`
        : `🏦 Dépôt validé pour ${pseudo} : +${dep.amount} 💎`,
    ];
    if (referralValidated && referrerPseudo) {
      feedLines.push(`🤝 Parrainage validé : ${referrerPseudo} +${referrerBonusGiven} 💎, ${pseudo} +${refereeBonusGiven} 💎`);
    }
    for (const line of feedLines) {
      await conn.query("INSERT INTO feed (pseudo, side, amount, title) VALUES ('Staff', 'yes', 0, ?)", [line]);
    }

    await conn.commit();
    return { ok: true, amount: dep.amount, bonus, pseudo, referralValidated, referrerPseudo, referrerBonusGiven, refereeBonusGiven };
  } catch (e) {
    await conn.rollback();
    console.error(e);
    return { ok: false, error: "Erreur serveur lors de l'approbation." };
  } finally {
    conn.release();
  }
}

// Un refus exige toujours une raison, enregistrée et montrée au joueur
// (voir rejectReason dans depositRowToJson) pour qu'il comprenne pourquoi.
async function rejectDeposit(depositId, reason) {
  const [result] = await pool.query(
    "UPDATE deposits SET status = 'rejected', reject_reason = ?, reviewed_at = NOW() WHERE id = ? AND status = 'pending'",
    [reason, depositId]
  );
  return result.affectedRows > 0;
}

app.post("/api/admin/deposits/:id/approve", authRequired, adminRequired, async (req, res) => {
  const result = await approveDeposit(req.params.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// Validation depuis le bouton/lien envoyé sur Discord : pas de session requise,
// authentifié uniquement par le token signé (voir signAdminAction).
app.get("/api/admin/deposits/:id/approve", async (req, res) => {
  if (!verifyAdminAction("deposit:approve", req.params.id, req.query.token)) {
    return res.status(403).send(actionResultHtml("Lien invalide ou expiré.", false));
  }
  const result = await approveDeposit(req.params.id);
  if (!result.ok) return res.send(actionResultHtml(`⚠️ ${result.error}`, false));
  const refLine = result.referralValidated
    ? `<br />🤝 Parrainage validé : <b>${result.referrerPseudo}</b> +${result.referrerBonusGiven} 💎, <b>${result.pseudo}</b> +${result.refereeBonusGiven} 💎.`
    : "";
  res.send(actionResultHtml(`Dépôt validé : <b>+${result.amount} 💎</b> pour <b>${result.pseudo}</b>.${refLine}`));
});

// Refus depuis le panel admin (staff connecté) : la raison est envoyée dans le corps.
app.post("/api/admin/deposits/:id/reject", authRequired, adminRequired, async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "Indique une raison de refus." });
  const rejected = await rejectDeposit(req.params.id, reason.slice(0, 300));
  if (!rejected) return res.status(400).json({ error: "Ce dépôt n'est plus en attente." });
  res.json({ ok: true });
});

// Depuis Discord : le lien "❌ Refuser" ouvre une petite page où le staff
// tape la raison, plutôt qu'un refus en un clic (voir rejectReasonFormHtml).
app.get("/api/admin/deposits/:id/reject", async (req, res) => {
  if (!verifyAdminAction("deposit:reject", req.params.id, req.query.token)) {
    return res.status(403).send(actionResultHtml("Lien invalide ou expiré.", false));
  }
  res.send(rejectReasonFormHtml("deposit", req.params.id, req.query.token));
});

// Soumission du formulaire ci-dessus : toujours authentifié par le token signé.
app.post("/api/admin/deposits/:id/reject-with-token", async (req, res) => {
  const { token, reason } = req.body || {};
  if (!verifyAdminAction("deposit:reject", req.params.id, token)) {
    return res.status(403).send(actionResultHtml("Lien invalide ou expiré.", false));
  }
  const cleanReason = String(reason || "").trim();
  if (!cleanReason) return res.send(actionResultHtml("⚠️ La raison est obligatoire.", false));
  const rejected = await rejectDeposit(req.params.id, cleanReason.slice(0, 300));
  if (!rejected) return res.send(actionResultHtml("⚠️ Ce dépôt n'est plus en attente.", false));
  res.send(actionResultHtml("🚫 Dépôt refusé."));
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
async function approveWithdrawal(withdrawalId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [wrows] = await conn.query("SELECT * FROM withdrawals WHERE id = ? FOR UPDATE", [withdrawalId]);
    const wd = wrows[0];
    if (!wd || wd.status !== "pending") {
      await conn.rollback();
      return { ok: false, error: "Ce retrait n'est plus en attente." };
    }

    await conn.query("UPDATE withdrawals SET status = 'approved', reviewed_at = NOW() WHERE id = ?", [wd.id]);

    const [arows] = await conn.query("SELECT pseudo FROM accounts WHERE id = ?", [wd.account_id]);
    const pseudo = arows[0] ? arows[0].pseudo : "?";
    await conn.query(
      "INSERT INTO feed (pseudo, side, amount, title) VALUES ('Staff', 'no', 0, ?)",
      [`🏧 Retrait payé à ${pseudo} : -${wd.amount} 💎`]
    );

    await conn.commit();
    return { ok: true, amount: wd.amount, pseudo };
  } catch (e) {
    await conn.rollback();
    console.error(e);
    return { ok: false, error: "Erreur serveur lors de l'approbation." };
  } finally {
    conn.release();
  }
}

app.post("/api/admin/withdrawals/:id/approve", authRequired, adminRequired, async (req, res) => {
  const result = await approveWithdrawal(req.params.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// Validation depuis le lien Discord : pas de session requise, authentifié par le token signé.
app.get("/api/admin/withdrawals/:id/approve", async (req, res) => {
  if (!verifyAdminAction("withdrawal:approve", req.params.id, req.query.token)) {
    return res.status(403).send(actionResultHtml("Lien invalide ou expiré.", false));
  }
  const result = await approveWithdrawal(req.params.id);
  if (!result.ok) return res.send(actionResultHtml(`⚠️ ${result.error}`, false));
  res.send(actionResultHtml(`Retrait marqué comme payé : <b>-${result.amount} 💎</b> pour <b>${result.pseudo}</b>.`));
});

// Refuser = on recrédite le solde du joueur (réservé à la demande) et on
// enregistre la raison donnée par le staff, affichée ensuite au joueur.
async function rejectWithdrawal(withdrawalId, reason) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [wrows] = await conn.query("SELECT * FROM withdrawals WHERE id = ? FOR UPDATE", [withdrawalId]);
    const wd = wrows[0];
    if (!wd || wd.status !== "pending") {
      await conn.rollback();
      return { ok: false, error: "Ce retrait n'est plus en attente." };
    }

    await conn.query("UPDATE accounts SET balance = balance + ? WHERE id = ?", [wd.amount, wd.account_id]);
    await conn.query(
      "UPDATE withdrawals SET status = 'rejected', reject_reason = ?, reviewed_at = NOW() WHERE id = ?",
      [reason, wd.id]
    );

    await conn.commit();
    return { ok: true, amount: wd.amount };
  } catch (e) {
    await conn.rollback();
    console.error(e);
    return { ok: false, error: "Erreur serveur lors du refus." };
  } finally {
    conn.release();
  }
}

app.post("/api/admin/withdrawals/:id/reject", authRequired, adminRequired, async (req, res) => {
  const reason = String(req.body?.reason || "").trim();
  if (!reason) return res.status(400).json({ error: "Indique une raison de refus." });
  const result = await rejectWithdrawal(req.params.id, reason.slice(0, 300));
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// Lien Discord "❌ Refuser" : passe par la même petite page de saisie de raison.
app.get("/api/admin/withdrawals/:id/reject", async (req, res) => {
  if (!verifyAdminAction("withdrawal:reject", req.params.id, req.query.token)) {
    return res.status(403).send(actionResultHtml("Lien invalide ou expiré.", false));
  }
  res.send(rejectReasonFormHtml("withdrawal", req.params.id, req.query.token));
});

app.post("/api/admin/withdrawals/:id/reject-with-token", async (req, res) => {
  const { token, reason } = req.body || {};
  if (!verifyAdminAction("withdrawal:reject", req.params.id, token)) {
    return res.status(403).send(actionResultHtml("Lien invalide ou expiré.", false));
  }
  const cleanReason = String(reason || "").trim();
  if (!cleanReason) return res.send(actionResultHtml("⚠️ La raison est obligatoire.", false));
  const result = await rejectWithdrawal(req.params.id, cleanReason.slice(0, 300));
  if (!result.ok) return res.send(actionResultHtml(`⚠️ ${result.error}`, false));
  res.send(actionResultHtml("🚫 Retrait refusé, le solde a été recrédité."));
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
