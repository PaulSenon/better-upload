# BRIEF — preserved request (phase 1)

> This file preserves the original request **verbatim** (French), followed by a structured breakdown with
> requirement IDs referenced from the other docs. Personal identifiers are intentionally omitted.
> Received 2026-11-12.

## Verbatim

> [Le porteur du projet] autorise création repo GitHub PUBLIC better-upload sur son compte authentifié (vérifie gh identity, ne pas écraser repo existant ni publier secrets), initialisation projet et étude/API design. Nom Better Upload provisoire même si déjà utilisé ailleurs, documenter collisions npm/marque sans bloquer repo. Objectif SDK OSS upload/download infra agnostique et type-safe, S3 compatible d'abord. Inspirations à étudier sources officielles actuelles : oRPC contrat/DX, UploadThing simplicité mais sans dépendance service obligatoire ni copier API aveuglément, Alchemy.run v2 modularité (Effect inspiration pas obligation), TanStack core TS framework agnostique bindings React seuls v0 puis autres, shadcn registry composants upload/progress UI stylables. Contrat partagé décrit endpoint upload logique, impl serveur du contrat produit router indépendant Express/etc via adapters. Une seule déclaration masque endpoints init/sign parts/status/complete/abort/refresh URLs, client dérivé connaît routage/base URL configurée sans secrets. Clés bucket uniquement serveur, auth/validation utilisateur plugables. Multipart uploads presigned URLs, reprise après réseau coupé/reload sur jours après resélection fichier, identité fichier fiable sans confondre fichiers, hashing performant mémoire bornée workers, retries/backoff/concurrence adaptative intégrité/idempotence, renouvellement URLs signées/credentials, reconciliation parts serveur/storage, lifecycle cleanup/couts orphanparts et limite fournisseurs. Download signé reprise HTTP Range validators/version objet, différences vrai multipart upload vs ranges download. Très gros fichiers sans limite arbitraire SDK mais documenter limites S3/providers/navigateur, pas promesse illimité. Cas cible upload intermittent depuis navigateur iPhone voyage sur plusieurs jours ; contraintes background iOS explicitement hors discussion principale, pas exigence bypass OS. UX robuste avec pause/reprise/progression, erreurs utilisables, cancellation ; DX quelques branchements bucket + contrat + router + client. Étudier architectures état persistant client/serveur minimal et adapters, pas imposer cloud ni DB sans justifier. Futur démonstrateur SwissTransfer/GrosFichiers service stockage offert public et chiffrement bout-en-bout : perspective séparée, pas à construire maintenant ; examiner implications E2EE/reprise/chunks/keys/ranges/validation, proposer pas crypto maison. PREMIÈRE PHASE SEULEMENT : recherche des intentions et alternatives, outline/questions ciblées à discuter, README draft comme doc lib core/server/client/React, spécification + interfaces TS et exemples/type tests compilables si utile ; runtime PAS autorisé, site/demo/deploy/npm PAS autorisés. [Le porteur] veut liberté pour première proposition puis common understanding et validation README/types avant impl, ne pas tenir propositions pour décisions. Préserver BRIEF exhaustif, decisions/questions avec statuts, recherche sourcée versions/date, README et types clairement design non impl. Crée/pousse repo public docs/types sans données privées; fournir URL confirmée, état et points à arbitrer dans dernier message. Opus coordonne et arbitre, peut déléguer recherche/revue si utile.

## Structured requirements

### Process & scope (P)

| ID | Requirement |
|---|---|
| P1 | Public GitHub repo `better-upload` on the authenticated account; check identity; never overwrite an existing repo; no secrets or private data. |
| P2 | "Better Upload" is a **provisional** name; document npm/brand collisions without blocking. |
| P3 | **Phase 1 only:** research of intentions & alternatives, outline + targeted questions, README draft (core/server/client/React), spec + TS interfaces, compilable examples/type tests if useful. |
| P4 | **Not authorized:** runtime implementation, website, demo, deployment, npm publish. |
| P5 | Proposals are **not decisions**; the project owner validates README + types before implementation. |
| P6 | Keep: this exhaustive brief, decisions/questions with statuses, sourced research with versions/dates, README & types clearly marked as design. |
| P7 | Final report: confirmed URL, state, points to arbitrate. |

### Product goals (G)

| ID | Requirement |
|---|---|
| G1 | OSS SDK for upload **and** download, infra-agnostic, type-safe; S3-compatible first. |
| G2 | DX: a few connections only — bucket + contract + router + client. |
| G3 | UX: robust pause / resume / progress, usable errors, cancellation. |
| G4 | No mandatory cloud or DB without justification; study minimal persistent client/server state and adapters. |

### Inspirations to study (I)

| ID | Source | Angle |
|---|---|---|
| I1 | oRPC | contract-first DX |
| I2 | UploadThing | simplicity — **without** mandatory service, without copying blindly |
| I3 | Alchemy.run v2 | modularity; Effect as inspiration, not obligation |
| I4 | TanStack | framework-agnostic TS core; React bindings only in v0, others later |
| I5 | shadcn registry | stylable upload/progress UI components |

### Architecture (A)

| ID | Requirement |
|---|---|
| A1 | Shared contract describes a *logical* upload endpoint. |
| A2 | Server implementation of the contract produces a router independent of Express/etc., via adapters. |
| A3 | One declaration hides init / sign parts / status / complete / abort / refresh URLs. |
| A4 | Derived client knows routing and configured base URL, holds no secrets. |
| A5 | Bucket keys server-only. |
| A6 | Pluggable user auth and validation. |

### Upload engine (U)

| ID | Requirement |
|---|---|
| U1 | Multipart upload via presigned URLs. |
| U2 | Resume after network loss **and** after reload, over **days**, after the user re-selects the file. |
| U3 | Reliable file identity — never confuse two files. |
| U4 | Performant hashing, bounded memory, workers. |
| U5 | Retries, backoff, adaptive concurrency, integrity, idempotency. |
| U6 | Renewal of signed URLs and credentials. |
| U7 | Reconciliation of parts between server and storage. |
| U8 | Lifecycle cleanup, cost of orphan parts, provider limits. |
| U9 | Very large files: no arbitrary SDK limit, but document S3 / provider / browser limits; no "unlimited" promise. |
| U10 | Target case: intermittent uploads from iPhone browser while travelling, over several days. iOS background constraints are **out of the main discussion**; no requirement to bypass the OS. |

### Download (D)

| ID | Requirement |
|---|---|
| D1 | Signed download with resume via HTTP Range, validators, object version. |
| D2 | Document the differences between true multipart upload and ranged download. |

### Future perspective (F) — not to build now

| ID | Requirement |
|---|---|
| F1 | Demonstrator: public free transfer service (SwissTransfer / GrosFichiers-like) with end-to-end encryption. |
| F2 | Examine E2EE implications for resume, chunks, keys, ranges, validation. |
| F3 | No home-made crypto. |

### Coordination (C)

| ID | Requirement |
|---|---|
| C1 | Opus coordinates and arbitrates; may delegate research/review. |
