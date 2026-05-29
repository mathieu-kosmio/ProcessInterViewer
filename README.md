# 🎙️ ProcesInterViewer

Application qui mène une **interview vocale** (OpenAI Realtime API) pour **cartographier
les processus métier** d'une entreprise à partir d'un **guide d'interview au format
Markdown**, puis génère automatiquement un **dossier complet** : fiches processus +
**diagrammes BPMN 2.0**.

Elle se décline en **deux modes, même base de code** :
- **Application de bureau** (Electron) — installable sur **Windows, macOS, Linux**. La
  clé API est saisie au premier lancement et stockée dans le **coffre sécurisé de l'OS**.
- **Application web** (Node/Express) — pour un déploiement serveur. La clé reste côté serveur.

## Comment ça marche

1. L'utilisateur ouvre la page, choisit/colle un guide d'interview (`.md`) et clique **Démarrer**.
2. Une voix IA conduit l'entretien : elle pose les questions, écoute et rebondit (full duplex via WebRTC).
3. À la fin, l'utilisateur clique **Terminer** : la transcription est analysée et un
   dossier structuré est produit (fiches + BPMN), **imprimable en PDF**.

```
Navigateur  ──micro/voix(WebRTC)──►  OpenAI Realtime API
    │  (jeton éphémère obtenu via le backend)
    ├──► /api/token     → crée un client_secret éphémère (la clé API reste serveur)
    └──► /api/dossier   → génère le dossier JSON (fiches + BPMN sémantique)
```

La **clé API OpenAI n'est jamais exposée au navigateur** : celui-ci ne reçoit qu'un
jeton éphémère à usage unique. Le rendu BPMN se fait côté client avec `bpmn-js` +
`bpmn-auto-layout`, **vendorisés en local** (`public/vendor/`, aucune dépendance CDN) ;
le modèle ne génère que le BPMN sémantique, la mise en page est calculée automatiquement.

---

## 🖥️ Application de bureau (Electron)

Dans ce mode, le serveur Express est **embarqué** dans l'app (sur un port localhost
interne) ; la clé API est **saisie par l'utilisateur au premier lancement** et stockée
dans le coffre sécurisé de l'OS via `safeStorage` (Keychain macOS / DPAPI Windows /
libsecret Linux). Aucun secret n'est inclus dans le package.

### Lancer en développement
```bash
npm install
npm run electron
```
Au premier lancement, un écran **Configuration** demande la clé API (on peut la changer
ensuite via « Changer la clé API » sur l'écran d'accueil).

### Construire les exécutables
```bash
npm run dist          # pour l'OS courant → dossier release/
# ou, pour produire les 3 plateformes (selon l'OS hôte) :
npm run dist:all
```
Cibles produites : **macOS** `.dmg` + `.zip` (x64 & arm64), **Windows** `.exe` (NSIS),
**Linux** `.AppImage` + `.deb`.

> ⚠️ **macOS** doit être construit sur une machine macOS (pas de cross-compilation du
> `.dmg`). Pour produire les 3 OS automatiquement, utilisez la CI (voir plus bas).

### Builds non signés — premier lancement
Les builds sont **non signés** (usage interne). À la première ouverture :
- **macOS** : clic droit sur l'app > **Ouvrir** (puis confirmer), ou
  `xattr -dr com.apple.quarantine "ProcesInterViewer.app"`.
- **Windows** : SmartScreen affiche « éditeur inconnu » → **Informations complémentaires
  > Exécuter quand même**.
- **Linux** : rendre l'AppImage exécutable (`chmod +x *.AppImage`).

### Construction automatique des 3 OS (CI)
Un workflow GitHub Actions (`.github/workflows/build.yml`) construit les 3 plateformes
en parallèle. Pousser un tag déclenche le build **et** la publication d'une release :
```bash
git tag v1.0.0 && git push origin v1.0.0
```
Aucun secret de signature requis (`GITHUB_TOKEN` suffit). Un build manuel est aussi
disponible via *workflow_dispatch* (onglet Actions).

### Régénérer les assets BPMN vendorisés
Après une mise à jour de `bpmn-js` / `bpmn-auto-layout` :
```bash
npm run vendor        # recompile public/vendor/ via esbuild
```

---

## 🌐 Application web (serveur)

### Prérequis
- Node.js ≥ 18 (fetch natif)
- Une clé API OpenAI avec accès à la Realtime API
- Un navigateur récent + un micro. **HTTPS ou `localhost`** requis pour le micro.

### Installation
```bash
cd ProcesInterViewer
cp .env.example .env        # puis renseigner OPENAI_API_KEY
npm install
npm start
```

Ouvrir http://localhost:3000

## Configuration (.env)

| Variable | Rôle | Défaut |
|---|---|---|
| `OPENAI_API_KEY` | Clé API (serveur uniquement) | — |
| `PORT` | Port HTTP | `3000` |
| `REALTIME_MODEL` | Modèle voix Realtime | `gpt-realtime` |
| `REALTIME_VOICE` | Voix de l'intervieweur (`marin`, `cedar`, `alloy`…) | `marin` |
| `DOSSIER_MODEL` | Modèle texte pour générer le dossier | `gpt-4o` |

> Si `gpt-realtime` est refusé, essayez `REALTIME_MODEL=gpt-realtime-2`
> (nom de modèle Realtime le plus récent dans la doc OpenAI 2026).

## Guides d'interview
- Tout fichier `.md` placé dans le dossier `guides/` apparaît dans le menu déroulant.
- On peut aussi charger un `.md` local ou éditer le guide directement dans l'interface.
- Un guide générique PME est fourni : `guides/guide-cartographie-process-pme.md`.

## Le dossier produit
Pour chaque processus identifié : objectif, déclencheur, résultat, acteurs, entrées/sorties,
applications, règles de gestion, KPI, irritants, volumétrie, étapes détaillées et
**diagramme BPMN**. Plus une **cartographie d'ensemble** (management / réalisation / support)
et une liste des **points à approfondir**.

Boutons : **Imprimer/PDF** (mise en page d'impression dédiée) et **export JSON** (réutilisable).

## Déploiement (mode web)
Déployable sur tout hébergeur Node (Railway, Render, Fly, un VPS…). En production,
servir en **HTTPS** (obligatoire pour l'accès micro hors `localhost`) et garder
`OPENAI_API_KEY` côté serveur. Possibilité d'ajouter une auth simple sur `/api/token`
pour éviter l'usage non autorisé.

> Pour la distribution **poste par poste** sans serveur à héberger, préférez
> l'**application de bureau** (section Electron ci-dessus).

## Limites connues
- Interview très longue ⇒ la génération du dossier peut atteindre la limite de tokens
  de sortie ; le cas échéant, augmenter `max_tokens` dans `server.js` ou scinder l'entretien.
- Le BPMN est volontairement « plat » (un seul process, sans couloirs) pour fiabiliser
  la mise en page automatique ; l'acteur de chaque tâche est indiqué dans son libellé.
- Whisper (`whisper-1`) est utilisé pour la transcription de l'utilisateur ; la qualité
  dépend du micro et de l'environnement sonore.
