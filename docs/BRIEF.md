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

## Addendum — owner feedback round 1 (2026-11-15, verbatim)

> side track question tu run in subagent: if we almost reuse 1:1 the orpc api, shoul/can it be an "extension/plugin" of orpc (v2) ? (genuine naive question)
>
> Q1: j'aime better-upload, mais si déjà un gros player existant, on trouvera autre chose.
> Q2: je pense si le client a perdu l'état c'est mort ? parce que je veux pas qu'on apporte de DB ou autre. peut-être juste l'app qui utilise notre lib va avoir enregistré en db le fait qu'un upload est en cours , et on peut éventuellement avoir une api qui lui permettrait sur un nouvel upload d'avoir sa logique pour en resume un ? sans que ça fasse parti de notre sdk
> Q3: j'aime bien la façon orpc
> Q4: la tu m'a perdu. je comprends pas pourquoi on a besoin de token in the first place
> Q5: je sais pas de quoi on parle
> Q6: pareil la j'ai du mal à capter de quoi on parle et des implications.
> Q7: je comprends pas de quoi on parle
> Q8: je sais pas de quoi on parle. niveau UX il faut qu'un download soit un lien unique pré signé pour un user et qu'il soit si possible retryabale si failure et que le user juste "retry" dans son navigateur. Je sais pas si on permet le download natif et UX simple ou si besoin d'avoir un download custom/resumable qui trigger le download natif à la fin du download local custom pour save sur la machine. (je crois c'est ce que font la plupart des web apps type drive de fichiers pour download. Mais je pense qu'on a des limites de taille pour buffer avant décrire dans un fichier sur l'os. donc je sais pas quel est le mieux. N'hésite pas à innover et boil the ocean pour trouver la meilleure solution perf/ux/cout/resilience
> Q9: on verra plus tard I guess.
>
> La premier shape api dans le readme est pas mal a priori meme si on fige rien pour le moment
>
> j'aimerais aussi avoir une api qui permet vraiment de se plug à des cms existant genre payloadcms, ou l'auth est qq part, le storage des fichiers ailleurs, la génération des id et liens dans la db cms encore ailleurs. il faut que ça soit smooth et on donnera meme des adapteurs/plugins/components pour les gros cms et ptetre aussi genre pour Convex (d'ailleurs je pense que ça vaut le coup de voir les partis pris de convex quand le cto a contribué un component pour host des fichier distant sur je sais plus quel service de cdn/hosting moins cher. )

### New / revised requirements

| ID | Requirement |
|---|---|
| G4′ | **No DB in the SDK.** If the browser lost its state and the host app kept nothing, the upload is lost. The host app may persist in-progress uploads itself; the SDK exposes what it needs to resume from that, without owning storage. |
| G5 | Smooth integration with host systems (e.g. Payload CMS, Convex) where auth, file storage, and ID/link generation + DB records live in different places. Official adapters/plugins/components for major CMSes / Convex later. |
| D3 | Download UX: one presigned link per user, retryable on failure by just "retry" in the browser; find the best perf/UX/cost/resilience trade-off (native vs managed download). |
| R1 | Side research: could the SDK be an oRPC v2 extension/plugin? |
