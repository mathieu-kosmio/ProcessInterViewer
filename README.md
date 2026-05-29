# 🎙️ ProcesInterViewer

Application web **ultra-simple** qui mène une **interview vocale** (OpenAI Realtime API)
pour **cartographier les processus métier** d'une entreprise à partir d'un **guide
d'interview au format Markdown**, puis génère automatiquement un **dossier complet** :
fiches processus + **diagrammes BPMN 2.0**.

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

La **clé API OpenAI ne quitte jamais le serveur** : le navigateur ne reçoit qu'un
jeton éphémère à usage unique. Le rendu BPMN se fait côté client avec `bpmn-js` +
`bpmn-auto-layout` (le modèle ne génère que le BPMN sémantique ; la mise en page est calculée automatiquement).

## Prérequis
- Node.js ≥ 18 (fetch natif)
- Une clé API OpenAI avec accès à la Realtime API
- Un navigateur récent + un micro. **HTTPS ou `localhost`** requis pour le micro.

## Installation

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

## Déploiement
Déployable sur tout hébergeur Node (Railway, Render, Fly, un VPS…). En production,
servir en **HTTPS** (obligatoire pour l'accès micro hors `localhost`) et garder
`OPENAI_API_KEY` côté serveur. Possibilité d'ajouter une auth simple sur `/api/token`
pour éviter l'usage non autorisé.

## Limites connues
- Interview très longue ⇒ la génération du dossier peut atteindre la limite de tokens
  de sortie ; le cas échéant, augmenter `max_tokens` dans `server.js` ou scinder l'entretien.
- Le BPMN est volontairement « plat » (un seul process, sans couloirs) pour fiabiliser
  la mise en page automatique ; l'acteur de chaque tâche est indiqué dans son libellé.
- Whisper (`whisper-1`) est utilisé pour la transcription de l'utilisateur ; la qualité
  dépend du micro et de l'environnement sonore.
