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

## Addendum — owner feedback round 2 (2026-11-15, verbatim)

> "Personne ne publie encore de lib d'upload pour oRPC, et l'issue oRPC #482 qui en demande une est toujours ouverte. Détails dans docs/research/orpc-extension.md." => side quest mais j'aimerais bien qu'on trouve la bonne façon de contribuer à orpc pour ce type de cas. vraiment pas la priorité. au moins j'aimerai faire avancer le débat.
>
> Pour le nom, on peut lancer une recherche de nom, mais c'est pas critique critique. D'ailleurs, ça m'intéresse sans spam le thread en cours, d'avoir plus d'infos sur en quoi consiste Better Upload. Si c'est vraiment exactement le même truc qu'on fait ou s'il y a un parti pris différent. Ensuite, Q2, l'histoire de faire 100 dB, ça c'est vraiment un truc qui me tient à cœur. Peu importe comment on définit la notion de ticket ou je sais pas quoi, c'est à toi de voir comment on fait. Qu'est-ce qui est le plus type-safe, le plus résilient et le plus simple à implémenter avec la meilleure DX. Effectivement, si le client ne se souvient pas de l'upload, par défaut, s'il n'y a rien de fait côté serveur, ben l'upload est perdu et il faudra juste le recommencer à zéro et l'autre il va expirer, donc on s'en fiche. Et bien sûr, faudra avertir l'utilisateur. Q5, pour vérifier si c'est le même fichier, je suis d'accord avec toi, faut faire un truc qui soit théoriquement impossible que ça match, quasi impossible que ça match si c'est pas le même fichier. Et avec un truc peu coûteux, sans charger le SDK qui est lourd. Quelle bibliothèque pour signer ? Bon, on va faire un truc minimum, effectivement. Pour la question 7, si un upload est abandonné et qu'il est timeout, effectivement, il faut recommencer à zéro et il faut prévenir l'utilisateur. Faut lui dire que le upload a expiré, donc il doit recommencer à zéro. Pour le téléchargement, je m'en fiche de ce que tu choisis, je te laisse prendre ce qui a la meilleure DX, et si ça peut être du progressive enhancement, c'est l'idéal. L'idée, c'est que ça marche le mieux possible, mais si c'est pas possible pour des raisons techniques sur une plateforme, un device spécifique, eh ben on fait au mieux. L'idée, c'est quand même de rendre possible le download. C'est ça qui est la priorité. S'il doit être re-recommencé à zéro pour des raisons techniques, tant pis. C'est mieux que de pas pouvoir le download tout court. Un mode proxy, pourquoi pas, mais uniquement si c'est du Cloudflare. Et la gestion du téléchargement, peut-être qu'on peut gérer ça en V1 et pas en V0. Mais on va faire dans la foulée, mais on peut déjà livrer la V0. Pour les intégrations, il me semblait que côté payload, c'était enfin dispo, mais si c'est pas dispo, effectivement, on va contribuer, ou au moins être compatible avec une page de doc dédiée. Pour Convex, je veux qu'on propose un composant Convex, comme Convex FS, sauf que nous, on n'est pas lié à buny.net, mais on est multi-provider. Et en plus de ça, on a le multi-part upload, la résilience et tout ça.

### New / revised requirements (round 2)

| ID | Requirement |
|---|---|
| G4″ | **No DB in the SDK** is a core value. Claude chooses the ticket mechanism, optimising type safety, resilience, implementation simplicity and DX. Lost client state + nothing on the host = the upload is restarted from zero, the old one simply expires; **the user must be told**. |
| I4 | File identity on resume: a different file must be (practically) impossible to accept, at low cost, without the heavy AWS SDK. |
| S1 | Minimal signer (no AWS SDK). |
| U11 | Expired/abandoned upload: restart from zero **and tell the user it expired** (Q7 = ask/inform, never silent). |
| D4 | Downloads: best DX, ideally **progressive enhancement**. Priority = the download is always *possible*; best effort per platform; restarting from zero is acceptable when resume is technically impossible. Proxy mode **only on Cloudflare**. Managed download in **v1**, right after v0. |
| H1 | Payload: if native resumable/multipart isn't available, contribute upstream or at least be compatible, with a dedicated docs page. |
| H2 | Convex: ship a **Convex component** like ConvexFS, but **multi-provider** (not tied to Bunny.net), with multipart upload and resilience. |
| R2 | Side quest (low priority): find the right way to contribute to oRPC for this use case; at least move the debate forward (#482). |
| N1 | Name search: welcome, not critical. Wants a clear picture of what the existing Better Upload is and whether its approach differs, without cluttering the main thread. |

## Addendum — owner feedback round 3 (2026-11-15, verbatim)

> Ne poste surtout rien sur ORPC, c'est moi qui ferai s'il y a besoin.
> Ok pour intégrer le composant Convex avant payload. Et j'ai pas compris ta question sur le composant Convex. De toute façon, on veut juste faire quasiment comme Convex FS pour regarder comment ça marche, comment créer des composants custom. Il y en a plein qui existent pour Better Auth, pour Stra, et pour plein de trucs qui sont bien faits. On a plein de sources d'inspiration.
> Pour le nom, tout ce que t'as trouvé, c'est de la merde. Je pense qu'on va juste l'appeler quelque chose upload. Et avec un genre un peu comme Théo qui préfixe tout avec T3, là je pourrais préfixer avec un truc à moi. Donc soit avec mon nom de famille, ce nom, soit un petit diminutif sympa que je peux commencer à utiliser partout.

### New / revised requirements (round 3)

| ID | Requirement |
|---|---|
| R3 | **Never post anything upstream** (oRPC or elsewhere). The owner posts himself if needed; drafts only. |
| H2′ | Convex component first, before Payload. Model it closely on ConvexFS and well-made existing components (Better Auth, Stripe, …); it is also a way to learn how custom components work. |
| N2 | Name = "<owner prefix> upload", T3-style personal prefix (surname or a short nickname the owner can reuse everywhere). Generic shortlist rejected. |
