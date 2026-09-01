# ParaBet — backend + base de données

Ce dossier contient tout ce qu'il faut pour héberger ParaBet avec une vraie
base de données MySQL, séparée de la base Vault/Essentials de ton serveur.

## Ce qu'il y a dedans

- `server.js` — l'API (Node.js + Express)
- `schema.sql` — la structure de la base de données à créer
- `public/index.html` — le site (identique visuellement, mais parle à l'API au lieu du stockage temporaire)
- `.env.example` — exemple de configuration à copier en `.env`
- `uploads/` — dossier où sont stockées les captures d'écran des dépôts

## 1. Prérequis sur le VPS

- Node.js 18+ (`node -v` pour vérifier)
- MySQL (ou MariaDB) installé et accessible
- (optionnel mais conseillé) `pm2` pour garder le serveur actif, et `nginx` en reverse proxy avec HTTPS (Let's Encrypt / certbot)

## 2. Créer la base de données

```bash
mysql -u root -p
```

Puis dans le shell MySQL, crée un utilisateur dédié (remplace le mot de passe) :

```sql
CREATE USER 'parabet'@'localhost' IDENTIFIED BY 'un_mot_de_passe_solide';
CREATE DATABASE parabet CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON parabet.* TO 'parabet'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

Puis importe le schéma :

```bash
mysql -u parabet -p parabet < schema.sql
```

## 3. Configurer l'environnement

```bash
cp .env.example .env
nano .env
```

Renseigne au minimum :
- `DB_USER` / `DB_PASSWORD` (ceux créés à l'étape 2)
- `JWT_SECRET` — génère une valeur aléatoire avec `openssl rand -hex 32`
- `ADMIN_CODE` — le code que tu donneras à ton staff pour qu'il obtienne les droits admin à l'inscription

## 4. Installer et lancer

```bash
npm install
npm start
```

Le site est alors accessible sur `http://ton-ip:3000` (ou le `PORT` que tu as choisi).

## 5. Garder le serveur actif en permanence (recommandé)

```bash
npm install -g pm2
pm2 start server.js --name parabet
pm2 save
pm2 startup   # puis suis les instructions affichées
```

## 6. Mettre un nom de domaine + HTTPS (recommandé)

Configure un reverse proxy nginx qui pointe vers `http://127.0.0.1:3000`, puis
utilise `certbot` pour activer le HTTPS. Une fois le HTTPS actif, dans
`server.js`, décommente la ligne `secure: true` dans `setAuthCookie` pour que
le cookie de session ne soit envoyé qu'en HTTPS.

## Comment ça fonctionne

- Les comptes, mots de passe (hashés avec bcrypt), marchés, paris, et
  l'historique d'activité sont stockés dans MySQL — plus rien ne se perd au
  redémarrage.
- La connexion utilise un cookie de session (JWT) — pas besoin de se
  reconnecter à chaque visite.
- Les captures d'écran des dépôts sont compressées côté navigateur puis
  envoyées comme vrais fichiers image dans `uploads/` (pas en base64 dans la
  base de données) — c'est plus léger et plus rapide à charger.
- Le flux de dépôt reste **manuel** : le site n'est toujours pas connecté à
  ton plugin économie (Vault/Essentials). Un joueur déclare un montant et
  joint une preuve ; toi (staff) tu vérifies visuellement dans l'onglet Admin
  avant d'approuver — l'approbation crédite alors instantanément son solde
  ParaBet.
- Le **retrait** fonctionne à l'envers du dépôt : un joueur demande un
  retrait, le montant est débité de son solde ParaBet immédiatement (pour
  qu'il ne puisse pas le miser en attendant). Toi (staff) tu remets les
  émeraudes en jeu à la main, puis tu marques la demande "payée" dans
  l'onglet Admin. Si tu refuses une demande, le montant est automatiquement
  recrédité au joueur.
- Le **parrainage** donne à chaque joueur un code unique (visible via le
  bouton "🤝 Parrainage") et un lien à partager. Un nouveau joueur qui
  s'inscrit avec ce code déclenche un bonus pour le parrain
  (`REFERRAL_BONUS_REFERRER`) et pour lui-même (`REFERRAL_BONUS_REFEREE`).
  Le lien de parrainage a la forme `https://ton-site/?ref=CODE` : le code se
  pré-remplit automatiquement dans le formulaire d'inscription.

## Sécurité — points à garder en tête

- Le code admin (`ADMIN_CODE`) donne les droits staff à l'inscription : ne le
  partage qu'avec des personnes de confiance, et change-le si tu penses qu'il
  a fuité.
- Il n'y a pas de limitation du nombre de tentatives de connexion : si tu
  veux durcir ça, ajoute un middleware de rate-limiting (ex: le paquet
  `express-rate-limit`) sur `/api/login` et `/api/register`.
- Les fichiers dans `uploads/` sont servis publiquement via une URL
  difficile à deviner (nom aléatoire), mais pas protégée par mot de passe :
  n'importe qui avec le lien direct peut voir l'image.
- Sauvegarde régulièrement ta base de données (`mysqldump`) une fois le site
  utilisé par de vrais joueurs.

## Aller plus loin : lier vraiment le solde en jeu

Ce système reste une validation manuelle par capture d'écran. Si un jour tu
veux une vraie automatisation (le joueur tape `/deposit 100` en jeu et le
site le détecte automatiquement), il faudrait un plugin Minecraft qui
appelle une route sécurisée de cette API (avec une clé secrète partagée)
pour créditer directement le compte ParaBet correspondant — n'hésite pas à
demander si tu veux qu'on construise cette partie plus tard. c'est 100% fictif aucune argent réel est utilisé
