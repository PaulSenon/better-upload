# Runbook : mise en production d'Open Upload

À lire de haut en bas. Chaque étape dit **qui** agit (toi ou moi), **quoi** exécuter, **comment vérifier**, et
**quand me redonner la main**. Tout ce qui pouvait être automatisé l'est déjà ; il ne reste que ce qui demande tes
comptes et tes secrets.

Durée totale : environ 1 h 30, dont 45 min d'attente de CI.

Prérequis sur ta machine : `node` 24, `pnpm` 10, `gh` connecté (`gh auth status`), Docker (pour MinIO en local).

---

## Étape 0 — Relire et merger la PR (toi, 10 min)

1. Ouvre https://github.com/PaulSenon/better-upload/pull/1 et la PR « delivery » empilée dessus, et relis-les. Merge
   d'abord la PR delivery dans `p0-implementation`, puis la PR #1 dans `main`.
2. Vérifie que tous les checks sont verts (CI, intégration MinIO, Convex, e2e Chromium/WebKit/Firefox/iPhone).
3. Merge :

   ```bash
   gh pr merge 1 --squash --delete-branch
   git checkout main && git pull
   ```

**Vérification :** `gh run list --branch main --limit 3` montre une exécution « CI » verte sur `main`.

La protection de `main` (checks obligatoires) se fait à l'étape 6.

> Si tu veux déplacer le repo dans une organisation GitHub `open-upload` (https://github.com/account/organizations/new,
> puis *Settings → Transfer ownership*), fais-le **maintenant** et **redonne-moi la main** : je mets à jour les URLs
> (`repository` dans les `package.json`, changelog, lien GitHub du site). Sinon, continue.

---

## Étape 1 — npm : créer l'organisation (toi, 5 min)

1. Connecte-toi sur https://www.npmjs.com (active la 2FA si ce n'est pas fait : *Account → Two-Factor Authentication*).
2. Crée l'organisation **`open-upload`** (gratuite pour des paquets publics) : https://www.npmjs.com/org/create
3. Dans un terminal :

   ```bash
   npm login            # ouvre le navigateur
   npm whoami           # doit afficher ton pseudo
   npm org ls open-upload   # doit te lister comme owner
   ```

---

## Étape 2 — npm : créer les paquets et la publication sans token (toi, 20 min)

npm ne permet de configurer la publication depuis la CI sans token (« trusted publishing ») que sur un paquet qui existe
déjà, et cette configuration expire si aucune publication n'a lieu dans les 2 jours. Le script crée donc chaque paquet
avec une version provisoire vide, que tu rejettes : aucun code n'est publié depuis ta machine. Détails :
[docs/RELEASING.md §8](RELEASING.md).

```bash
cd better-upload && git checkout main && git pull && pnpm install
npx --yes npm@11.21.2 login
node tooling/release/bootstrap.mjs check            # lecture seule : org open-upload, rôle owner, 6 paquets absents
node tooling/release/bootstrap.mjs stage            # une version provisoire par paquet → note les 6 « stage ID »
node tooling/release/bootstrap.mjs reject <id> <id> <id> <id> <id> <id>   # 2FA ; les paquets existent désormais
```

**À faire d'une traite (expiration 2 jours) :**

```bash
node tooling/release/bootstrap.mjs trust            # 2FA : GitHub · PaulSenon/better-upload · release.yml · npm-release
```

Puis sur GitHub, crée les environnements `npm-release` (branches `main` et `next`, sans reviewer) et `release-finalize`
(branches `main` et `next`, **reviewer obligatoire : toi**) : https://github.com/PaulSenon/better-upload/settings/environments/new

```bash
gh variable set NPM_RELEASE_ENABLED --body true
```

**Vérification :** `node tooling/release/bootstrap.mjs status` montre pour chaque paquet le trusted publisher attendu.

---

## Étape 3 — Première version 0.1.0 (toi, 20 min)

1. Le workflow `version-pr` ouvre la PR « Version packages ». Ferme-la puis rouvre-la pour que la CI tourne dessus
   (une PR ouverte par la CI ne déclenche pas la CI), puis merge-la.
2. Lance la release :

   ```bash
   gh workflow run release.yml --ref main -f confirm_version=0.1.0
   ```

3. Quand le job `stage` est vert, suis la checklist de [docs/RELEASING.md §4](RELEASING.md) puis approuve chaque
   paquet sur https://www.npmjs.com (onglet *Staged Packages*, 2FA).
4. Dans le run : *Review deployments* → `release-finalize` → *Approve and deploy*. Le job crée les tags et les
   releases GitHub.
5. Verrouille chaque paquet : npmjs.com → paquet → *Settings → Publishing access* → *Require two-factor authentication
   and disallow tokens*. Puis `npx --yes npm@11.21.2 logout`.

**Vérification :**

```bash
for p in core s3 server client react convex; do npm view @open-upload/$p version; done   # 0.1.0 partout, badge Provenance
```

> Si `stage`, `trust` ou `finalize` échoue : **redonne-moi la main** avec la sortie complète.

---

## Étape 4 — Cloudflare : compte et token temporaire (toi, 10 min)

1. Compte Cloudflare : https://dash.cloudflare.com/sign-up (gratuit). C'est le même compte que WebMCP.
2. Active ton sous-domaine Workers une fois : *Workers & Pages* → *Overview*.
3. **Account ID** : *Workers & Pages* → colonne de droite *Account details*.
4. **Token temporaire** : *Manage Account → API Tokens → Create Token → Custom token*, nom `site-bootstrap-temp`,
   permissions *Workers: Admin (All Workers)* et *Account Secrets Store: Edit*, expiration **demain**. Enregistre-le
   dans un fichier (`chmod 600`).

---

## Étape 5 — Amorçage du site (toi ou moi, 15 min)

```bash
node infra/site/scripts/bootstrap.ts --account-id <id> --token-file <fichier> --out-dir ~/site-bootstrap-secrets
```

Le script vérifie le token et crée les deux stockages d'état (prod et previews), dont il écrit les jetons dans le
dossier privé. Il crée aussi le Worker de prod `better-upload-site` avec une page provisoire, uniquement s'il
n'existe pas.

Ensuite, crée les deux tokens CI ([docs/SITE-DEPLOY.md §3](SITE-DEPLOY.md)) :
- **production** : Editor sur le seul Worker `better-upload-site` ;
- **preview** : Workers edit sur tout le compte, pour une preview par PR.
  - **Risque :** ce token peut toucher tous les Workers du compte, y compris ceux de WebMCP.
  - **Ce qui le limite :** il n'est lisible que depuis `main`.
  - **Pour éviter ce risque :** `--preview-mode staging`, avec un token limité à `better-upload-site-staging`.

> Si la commande échoue : **redonne-moi la main** avec la sortie complète. C'est la partie qui n'a jamais tourné sur un
> vrai compte.

---

## Étape 6 — Réglages GitHub et déploiement continu (toi, 10 min)

D'abord **à blanc** : le script affiche chaque appel, jamais une valeur secrète.

```bash
node tooling/setup-github.mjs --repo PaulSenon/better-upload --reviewer <ton login GitHub> \
  --account-id <id> --subdomain <sous-domaine> \
  --prod-token-file <token prod> --preview-token-file <token preview> --state-dir ~/site-bootstrap-secrets \
  --preview-mode dynamic
```

Relis la sortie, puis relance la même commande avec `--apply`. Elle crée :
- les environnements `site-preview` et `site-production`, limités à `main` et sans reviewer ;
- `npm-release` (sans reviewer : ta 2FA npm fait office de verrou) ;
- `release-finalize` (reviewer : toi) ;
- les secrets et variables du site ;
- le ruleset `delivery-kit`, qui exige une PR et les checks.

Ensuite :

```bash
gh variable set SITE_DEPLOY_ENABLED --body true
rm -rf ~/site-bootstrap-secrets <fichiers de token>
```

Supprime enfin le token temporaire dans Cloudflare.

**Comment ça marche :**
- **Push sur `main`** : la prod est mise à jour, après tous les checks verts sur ce commit.
- **PR prête (pas en brouillon)** : la preview est déployée quand tous les checks de son dernier commit sont verts. Son
  URL apparaît dans un commentaire unique, mis à jour à chaque push, et dans le statut `site-preview`.
- **Fermeture, merge ou retour en brouillon** : la preview est retirée. Un nettoyage hebdomadaire rattrape les oublis.

**Vérification :** ouvre une petite PR. Le workflow `site-deploy` passe vert, le commentaire affiche l'URL, et l'URL
sert le site. Ferme la PR : le commentaire passe à « removed ».

---

## Étape 7 — Domaine personnalisé (optionnel)

Si tu veux `open-upload.dev` (ou autre) :
1. Ajoute le domaine dans Cloudflare : *Websites → Add a site*.
2. **Redonne-moi la main** en me donnant le domaine : j'ajoute une ligne `domain` dans `apps/web/alchemy.run.ts` et je
   mets à jour les URLs de la doc. Le déploiement continu fait le reste.

Les commandes d'installation du registry affichées dans la doc utilisent automatiquement l'URL réelle du site.

---

## Étape 8 — Tests sur les vrais fournisseurs (optionnel, 15 min)

La CI teste les PR contre MinIO. Les tests sur R2 et AWS tournent dans le workflow `cloud-tests`, chaque mardi ou à la main, jamais
depuis une PR. Leurs clés sont dans l'environnement `cloud-tests`, limité à `main`, donc aucune PR ne peut les lire.

1. Crée un bucket **dédié aux tests** chez chaque fournisseur :
   - **R2** : bucket `open-upload-ci`, token *Object Read & Write* limité à ce bucket.
   - **AWS** : bucket `open-upload-ci-<suffixe>`, utilisateur IAM limité à ce bucket (`s3:PutObject`, `GetObject`,
     `DeleteObject`, `ListBucket`, `ListMultipartUploadParts`, `AbortMultipartUpload`), règle *Abort incomplete
     multipart uploads after 1 day*.
2. Crée l'environnement `cloud-tests` (branche `main` uniquement), puis :

   ```bash
   gh secret set R2_ACCESS_KEY_ID --env cloud-tests
   gh secret set R2_SECRET_ACCESS_KEY --env cloud-tests
   gh secret set AWS_ACCESS_KEY_ID --env cloud-tests
   gh secret set AWS_SECRET_ACCESS_KEY --env cloud-tests
   gh variable set R2_ACCOUNT_ID --body <account id>
   gh variable set R2_BUCKET --body open-upload-ci
   gh variable set AWS_REGION --body eu-west-3
   gh variable set AWS_BUCKET --body open-upload-ci-<suffixe>
   gh variable set CLOUD_TESTS_ENABLED --body true
   gh workflow run cloud-tests --ref main
   ```

**Vérification :** le job `cloud-tests` est vert, et le tableau de conformité de chaque fournisseur apparaît
dans ses logs.

> Si un check de conformité échoue : **redonne-moi la main** avec le tableau.

---

## Étape 9 — Vérification finale (toi, 5 min)

Dans un projet shadcn existant :

```bash
npx shadcn@latest add https://<ton-site>/r/upload.json
npm i @open-upload/client @open-upload/react   # normalement déjà installés par la commande ci-dessus
```

Puis suis la page *Quick start* du site : une route serveur, un client, `<UploadDropzone />`. Upload d'un gros fichier,
coupure du Wi-Fi, rechargement de la page, resélection du fichier : l'upload reprend où il s'était arrêté.

---

## Récapitulatif : quand me redonner la main

| Moment | Pourquoi |
|---|---|
| Après un transfert du repo vers une organisation (étape 0) | Mettre à jour les URLs |
| Si un script d'amorçage échoue (étapes 2, 3, 5) | Corriger l'outillage |
| Avec un domaine personnalisé (étape 7) | Brancher le domaine |
| Si un fournisseur réel échoue au kit de conformité (étape 8) | Corriger l'adaptateur |
| Quand tout est vert | Suite : premières releases via la CI, annonce, référencement du registry dans l'annuaire shadcn |
