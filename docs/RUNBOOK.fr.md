# Runbook : mise en production d'Open Upload

À lire de haut en bas. Chaque étape dit **qui** agit (toi ou moi), **quoi** exécuter, **comment vérifier**, et
**quand me redonner la main**. Tout ce qui pouvait être automatisé l'est déjà ; il ne reste que ce qui demande tes
comptes et tes secrets.

Durée totale : environ 1 h 30, dont 45 min d'attente de CI.

Prérequis sur ta machine : `node` 24, `pnpm` 10, `gh` connecté (`gh auth status`), Docker (pour MinIO en local).

---

## Étape 0 — Relire et merger la PR (toi, 10 min)

1. Ouvre https://github.com/PaulSenon/better-upload/pull/1 et relis le résumé.
2. Vérifie que tous les checks sont verts (CI, intégration MinIO, Convex, e2e Chromium/WebKit/Firefox/iPhone).
3. Merge :

   ```bash
   gh pr merge 1 --squash --delete-branch
   git checkout main && git pull
   ```

**Vérification :** `gh run list --branch main --limit 3` montre une exécution « CI » verte sur `main`.

Optionnel mais recommandé : protéger `main` (CI obligatoire avant merge) :
https://github.com/PaulSenon/better-upload/settings/branches → *Add classic branch protection rule* → `main` →
*Require status checks to pass* → coche `Lint, types, unit tests, build`, `Integration (MinIO)`,
`Convex component (local backend + MinIO)`, `Docs & registry build`, `E2E (chromium)`.

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

## Étape 2 — Première publication, à la main (toi, 10 min)

npm ne permet de configurer la publication sans token (« trusted publishing ») que sur des paquets qui existent déjà.
La toute première version part donc de ta machine ; toutes les suivantes partiront de la CI.

```bash
cd better-upload && git checkout main && git pull
pnpm install
export GITHUB_TOKEN=$(gh auth token)      # le changelog cite les PRs
pnpm changeset version                    # 0.0.0 → 0.1.0 + CHANGELOG.md par paquet
git add -A && git commit -m "chore: release 0.1.0" && git push
# Si tu as protégé `main` à l'étape 0, passe par une PR à la place du push :
#   git checkout -b release/0.1.0 && git push -u origin release/0.1.0 && gh pr create --fill && gh pr merge --squash
#   git checkout main && git pull
pnpm build && pnpm check:packages         # build + publint + attw, doit être vert
node scripts/publish.mjs --dry-run        # doit lister les 6 paquets @open-upload/*@0.1.0
node scripts/publish.mjs                  # npm te demande un code 2FA pour chaque paquet
git tag -a v0.1.0 -m "v0.1.0" && git push --tags
```

**Vérification :**

```bash
for p in core s3 server client react convex; do npm view @open-upload/$p version; done   # 0.1.0 partout
```

et https://www.npmjs.com/org/open-upload liste 6 paquets.

---

## Étape 3 — npm : publication depuis la CI, sans token (toi, 10 min)

Pour **chacun** des 6 paquets (`core`, `s3`, `server`, `client`, `react`, `convex`) :

1. Ouvre `https://www.npmjs.com/package/@open-upload/<nom>/access`
2. Section **Trusted Publisher** → *GitHub Actions* :
   - Organization or user : `PaulSenon`
   - Repository : `better-upload`
   - Workflow filename : `release.yml`
   - Environment : `npm`
3. Section **Publishing access** → *Require two-factor authentication and disallow tokens* → *Update Package Settings*.

Puis côté GitHub :

1. Crée l'environnement protégé `npm` : https://github.com/PaulSenon/better-upload/settings/environments/new
   - Nom : `npm`
   - *Required reviewers* : toi
   - *Deployment branches and tags* : *Selected branches* → `main`
2. Active les releases :

   ```bash
   gh variable set NPM_RELEASE_ENABLED --body true
   ```

**Comment ça marche ensuite :**
1. Une PR qui change un paquet contient un changeset (`pnpm changeset`).
2. Au merge, la CI ouvre une PR **« chore: version packages »**.
3. Quand tu merges celle-ci, le job de publication attend **ton approbation** (environnement `npm`), puis publie avec provenance.

**Vérification (plus tard, à la prochaine release) :** sur npm, chaque version publiée par la CI affiche le badge
*Provenance*.

---

## Étape 4 — Cloudflare : compte et token (toi, 10 min)

1. Compte Cloudflare : https://dash.cloudflare.com/sign-up (gratuit).
2. Active ton sous-domaine Workers une fois : *Workers & Pages* → *Overview* → choisis un sous-domaine `*.workers.dev`.
3. **Account ID** : *Workers & Pages* → colonne de droite *Account details* → copie l'Account ID (32 caractères hexadécimaux).
4. **Token API** : https://dash.cloudflare.com/profile/api-tokens → *Create Token* → modèle **Edit Cloudflare Workers** → *Use template*, puis ajoute ces permissions :
   - *Account* · *Secrets Store* · *Edit* (Alchemy y range son état, partagé entre ton laptop et la CI)
   - *Account* · *Account Settings* · *Read*
   - Account Resources : ton compte. Zone Resources : *All zones* (ou ta zone si domaine perso).
   - *Continue to summary* → *Create Token* → copie le token (affiché une seule fois).

---

## Étape 5 — Premier déploiement du site, depuis ta machine (toi, 10 min)

Ce premier déploiement crée aussi le stockage d'état d'Alchemy dans ton compte Cloudflare.

```bash
cd better-upload/apps/web
export CLOUDFLARE_API_TOKEN=<token de l'étape 4>
export CLOUDFLARE_ACCOUNT_ID=<account id de l'étape 4>
pnpm exec alchemy deploy --stage prod --yes
```

La commande se termine en affichant `url: https://….workers.dev`.

**Vérifications :**
- Ouvre l'URL : la page d'accueil s'affiche, et la démo marche (dépose un fichier : il monte jusqu'à 100 %).
- `<url>/docs` affiche la doc avec les deux onglets *Documentation* / *Components*.
- `curl -s <url>/r/upload.json | head -c 200` renvoie du JSON shadcn.
- `curl -s <url>/llms.txt | head` liste les pages.

> **Si la commande échoue : redonne-moi la main** avec la sortie complète. C'est le seul morceau d'infra que je n'ai
> pas pu exécuter moi-même (pas de compte Cloudflare) ; le stack a été vérifié jusqu'à l'authentification.

---

## Étape 6 — Déploiement continu du site (toi, 5 min)

```bash
gh secret set CLOUDFLARE_API_TOKEN       # colle le token
gh secret set CLOUDFLARE_ACCOUNT_ID      # colle l'account id
```

Crée deux environnements (sans protection, ou avec reviewer pour `site-prod` si tu veux valider chaque mise en prod) :
- https://github.com/PaulSenon/better-upload/settings/environments/new → `site-prod`
- https://github.com/PaulSenon/better-upload/settings/environments/new → `site-preview`

```bash
gh variable set SITE_DEPLOY_ENABLED --body true
```

**Comment ça marche :**
- **Push sur `main`** : le site de prod est mis à jour.
- **Chaque PR qui touche le site ou les paquets** : un aperçu `pr-<numéro>` est déployé, et son URL apparaît dans les logs du job *Deploy site*. L'aperçu est détruit à la fermeture de la PR.

**Vérification :** ouvre une petite PR (par exemple une faute de frappe dans `apps/web/content/docs/(docs)/index.mdx`).
Le job *Deploy site* passe vert et affiche l'URL de l'aperçu. Ferme la PR : le job détruit l'aperçu.

---

## Étape 7 — Domaine personnalisé (optionnel)

Si tu veux `open-upload.dev` (ou autre) :
1. Ajoute le domaine dans Cloudflare : *Websites → Add a site*.
2. **Redonne-moi la main** en me donnant le domaine : j'ajoute une ligne `domain` dans `apps/web/alchemy.run.ts` et je
   mets à jour les URLs de la doc. Le déploiement continu fait le reste.

Les commandes d'installation du registry affichées dans la doc utilisent automatiquement l'URL réelle du site.

---

## Étape 8 — Tests sur les vrais fournisseurs dans la CI (optionnel, 15 min)

Aujourd'hui la CI teste contre MinIO. Pour qu'elle teste aussi R2 et AWS à chaque PR (adaptateur + kit de conformité +
upload complet), crée un bucket **dédié aux tests** :

**Cloudflare R2**
1. *R2 Object Storage → Create bucket* → `open-upload-ci`.
2. *R2 → Manage R2 API Tokens → Create API token* → *Object Read & Write*, limité au bucket `open-upload-ci`.
3. Enregistre :

   ```bash
   gh variable set R2_ACCOUNT_ID --body <account id>
   gh variable set R2_BUCKET --body open-upload-ci
   gh secret set R2_ACCESS_KEY_ID
   gh secret set R2_SECRET_ACCESS_KEY
   ```

**AWS S3**
1. Crée le bucket `open-upload-ci-<suffixe>` dans ta région, puis un utilisateur IAM avec une policy limitée à ce bucket :
   `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket`, `s3:ListMultipartUploadParts`,
   `s3:AbortMultipartUpload`.
2. Ajoute à ce bucket une règle de cycle de vie *Abort incomplete multipart uploads after 1 day*.
3. Enregistre :

   ```bash
   gh variable set AWS_REGION --body eu-west-3
   gh variable set AWS_BUCKET --body open-upload-ci-<suffixe>
   gh secret set AWS_ACCESS_KEY_ID
   gh secret set AWS_SECRET_ACCESS_KEY
   ```

**Vérification :** relance la CI (`gh workflow run CI` ou un push) ; le job s'appelle maintenant
« Integration (MinIO, R2, AWS) » et le tableau de conformité de chaque fournisseur apparaît dans ses logs.

> Si un check de conformité échoue sur R2 ou AWS, **redonne-moi la main** avec le tableau : c'est exactement ce que le
> kit est là pour révéler, et je corrigerai l'adaptateur ou la déclaration du fournisseur.

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
| Si `alchemy deploy` échoue (étape 5) | Corriger le stack d'infra |
| Avec un domaine personnalisé (étape 7) | Brancher le domaine |
| Si un fournisseur réel échoue au kit de conformité (étape 8) | Corriger l'adaptateur |
| Quand tout est vert | Suite : premières releases via la CI, annonce, référencement du registry dans l'annuaire shadcn |
