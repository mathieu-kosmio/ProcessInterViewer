import express from "express";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createStore } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/*  Factory : cree l'app Express SANS appeler .listen().               */
/*  La cle API est fournie via getApiKey() et lue A CHAQUE requete,    */
/*  ce qui permet aux deux modes (web standalone + Electron) de        */
/*  fonctionner : en web elle vient de process.env, en Electron du     */
/*  coffre securise de l'OS (safeStorage), saisie par l'utilisateur.   */
/* ------------------------------------------------------------------ */
export function createServer({ getApiKey, config = {}, dataDir } = {}) {
  const REALTIME_MODEL = config.realtimeModel || process.env.REALTIME_MODEL || "gpt-realtime";
  const REALTIME_VOICE = config.realtimeVoice || process.env.REALTIME_VOICE || "marin";
  const DOSSIER_MODEL = config.dossierModel || process.env.DOSSIER_MODEL || "gpt-4o";

  const resolveKey = typeof getApiKey === "function" ? getApiKey : () => undefined;

  // Historique des sessions : en Electron dataDir = userData ; en web,
  // dossier ./data a cote du projet.
  const store = createStore(dataDir || join(__dirname, "data"));

  const app = express();
  app.use(express.json({ limit: "8mb" }));
  app.use(express.static(join(__dirname, "public")));
  app.use("/guides", express.static(join(__dirname, "guides")));

  /* ---------------------------------------------------------------- */
  /*  1. Jeton ephemere pour la Realtime API (WebRTC cote navigateur) */
  /* ---------------------------------------------------------------- */
  app.post("/api/token", async (req, res) => {
    const apiKey = await resolveKey();
    if (!apiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY non configuree." });
    }
    try {
      const voice = (req.body && req.body.voice) || REALTIME_VOICE;
      const sessionConfig = {
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          audio: { output: { voice } },
        },
      };

      const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(sessionConfig),
      });

      const text = await r.text();
      if (!r.ok) {
        console.error("Erreur client_secrets:", r.status, text);
        return res.status(r.status).json({ error: "Echec creation jeton", detail: text });
      }
      const data = JSON.parse(text);
      // La cle ephemere est dans data.value (GA) ; on renvoie aussi le modele.
      res.json({ value: data.value, expires_at: data.expires_at, model: REALTIME_MODEL });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  /* ---------------------------------------------------------------- */
  /*  2. Liste des guides d'interview disponibles (dossier /guides)   */
  /* ---------------------------------------------------------------- */
  app.get("/api/guides", async (_req, res) => {
    try {
      const files = await readdir(join(__dirname, "guides"));
      res.json(files.filter((f) => f.toLowerCase().endsWith(".md")));
    } catch {
      res.json([]);
    }
  });

  /* ---------------------------------------------------------------- */
  /*  3. Generation du dossier final (fiches process + BPMN)          */
  /* ---------------------------------------------------------------- */
  app.post("/api/dossier", async (req, res) => {
    const apiKey = await resolveKey();
    if (!apiKey) {
      return res.status(500).json({ error: "OPENAI_API_KEY non configuree." });
    }
    const { transcript, guide, meta, parentId } = req.body || {};
    if (!transcript || !transcript.trim()) {
      return res.status(400).json({ error: "Transcript vide." });
    }

    // Mode enrichissement : on recharge le dossier anterieur de la lignee
    // pour fusionner de maniere incrementale (conserver / mettre a jour /
    // ajouter), au lieu de repartir de zero.
    let previousDossier = null;
    if (parentId) {
      const parent = await store.get(parentId);
      if (parent && parent.dossier) previousDossier = parent.dossier;
    }

    const system = buildDossierSystemPrompt({ incremental: Boolean(previousDossier) });
    const user = buildDossierUserPrompt({ transcript, guide, meta, previousDossier });

    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: DOSSIER_MODEL,
          temperature: 0.2,
          max_tokens: 16000,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });

      const text = await r.text();
      if (!r.ok) {
        console.error("Erreur dossier:", r.status, text);
        return res.status(r.status).json({ error: "Echec generation dossier", detail: text });
      }
      const completion = JSON.parse(text);
      const content = completion.choices?.[0]?.message?.content || "{}";
      let dossier;
      try {
        dossier = JSON.parse(content);
      } catch (e) {
        return res.status(502).json({ error: "Reponse JSON invalide du modele", detail: content.slice(0, 2000) });
      }

      // Enregistre la session dans l'historique (best-effort : un echec de
      // sauvegarde ne doit pas priver l'utilisateur de son dossier).
      // parentId => nouvelle version reliee a la lignee existante.
      let saved = null;
      try {
        saved = await store.save({ meta, guide, transcript, dossier, parentId });
      } catch (e) {
        console.error("Echec sauvegarde historique:", e);
      }

      res.json({ ...dossier, _id: saved?.id, _version: saved?.version, _createdAt: saved?.createdAt });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  /* ---------------------------------------------------------------- */
  /*  4. Config publique consommee par le frontend (sans secret)      */
  /* ---------------------------------------------------------------- */
  app.get("/api/config", async (_req, res) => {
    const apiKey = await resolveKey();
    res.json({
      model: REALTIME_MODEL,
      voice: REALTIME_VOICE,
      hasKey: Boolean(apiKey),
    });
  });

  /* ---------------------------------------------------------------- */
  /*  5. Historique des sessions (fiches consultables ulterieurement) */
  /* ---------------------------------------------------------------- */
  // Liste des sessions (resumes, tries du plus recent)
  app.get("/api/history", async (_req, res) => {
    try {
      res.json(await store.list());
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: String(err) });
    }
  });

  // Versions d'une lignee (tracabilite). Defini AVANT /:id pour ne pas
  // etre capture par le parametre generique.
  app.get("/api/history/:lineageId/versions", async (req, res) => {
    res.json(await store.versions(req.params.lineageId));
  });

  // Detail complet d'une session (meta + guide + transcript + dossier)
  app.get("/api/history/:id", async (req, res) => {
    const rec = await store.get(req.params.id);
    if (!rec) return res.status(404).json({ error: "Session introuvable." });
    res.json(rec);
  });

  // Suppression d'une session
  app.delete("/api/history/:id", async (req, res) => {
    const ok = await store.remove(req.params.id);
    res.json({ ok });
  });

  return app;
}

/* ------------------------------------------------------------------ */
/*  Demarre le serveur sur 127.0.0.1 (jamais 0.0.0.0).                 */
/*  port=0 => l'OS attribue un port libre, recupere via address().    */
/*  Renvoie { server, port }.                                          */
/* ------------------------------------------------------------------ */
export function startServer(opts = {}) {
  const app = createServer(opts);
  return new Promise((resolve, reject) => {
    const srv = app.listen(opts.port ?? 0, "127.0.0.1", () => {
      resolve({ server: srv, port: srv.address().port });
    });
    srv.on("error", reject);
  });
}

/* ------------------------------------------------------------------ */
/*  Prompts                                                            */
/* ------------------------------------------------------------------ */
function buildDossierSystemPrompt({ incremental = false } = {}) {
  const incrementalBlock = incremental
    ? `

MODE MISE A JOUR INCREMENTALE (IMPORTANT) :
On te fournit en plus un DOSSIER ANTERIEUR (cartographie deja etablie lors d'entretiens precedents). Tu ne repars PAS de zero : tu produis une version A JOUR de ce dossier en appliquant ces regles de fusion :
- CONSERVE tel quel tout processus du dossier anterieur qui n'est PAS aborde dans la nouvelle transcription (ne le supprime pas, ne l'appauvris pas).
- METS A JOUR un processus existant uniquement si la nouvelle transcription apporte des informations nouvelles, des corrections ou des changements le concernant ; integre alors ces evolutions sans perdre les details anterieurs encore valides.
- AJOUTE les nouveaux processus evoques qui n'existaient pas.
- Conserve les "id" des processus anterieurs (P01, P02...) ; attribue de nouveaux id aux nouveaux processus.
- Si l'interviewe revient explicitement sur un sujet pour le modifier/corriger, la nouvelle information PREVAUT sur l'ancienne.
- Mets a jour la cartographie d'ensemble et les "lacunes" en consequence (retire des lacunes ce qui a ete comble).
- Pour un processus modifie, regenere son bpmn_xml pour refleter le deroulement a jour ; pour un processus inchange, tu peux conserver son bpmn_xml anterieur.
Le resultat final doit etre un dossier COMPLET et autonome (anciens + nouveaux elements fusionnes), pas seulement les nouveautes.`
    : "";

  return `Tu es un consultant senior en organisation et en cartographie des processus metier (approche type ISO 9001 / norme BPMN 2.0). On te fournit la transcription d'une interview vocale menee aupres d'une entreprise, ainsi que le guide d'interview utilise. Ta mission : produire un DOSSIER COMPLET et structure cartographiant l'ensemble des processus metier evoques.${incrementalBlock}

Tu dois repondre UNIQUEMENT avec un objet JSON valide (aucun texte hors JSON), respectant exactement ce schema :

{
  "entreprise": {
    "nom": string,
    "secteur": string,
    "effectif": string,
    "synthese": string  // 3-6 phrases : activite, perimetre, enjeux d'organisation
  },
  "cartographie": {
    "management": [string],   // noms des processus de pilotage/management
    "realisation": [string],  // noms des processus coeur de metier
    "support": [string]       // noms des processus support
  },
  "processus": [
    {
      "id": string,                 // ex "P01"
      "nom": string,
      "categorie": "management" | "realisation" | "support",
      "objectif": string,
      "declencheur": string,        // evenement qui demarre le processus
      "resultat": string,           // resultat / livrable final
      "acteurs": [string],          // roles/fonctions impliques
      "entrees": [string],          // donnees / documents en entree
      "sorties": [string],          // donnees / documents en sortie
      "applications": [string],     // outils / logiciels utilises
      "regles_gestion": [string],   // regles metier, controles, conditions
      "kpis": [string],             // indicateurs de performance
      "irritants": [string],        // points de douleur, risques, inefficacites
      "volumetrie": string,         // frequence / volume (si connu, sinon "")
      "etapes": [
        { "ordre": number, "nom": string, "acteur": string, "description": string, "type": "tache" | "decision" }
      ],
      "bpmn_xml": string            // BPMN 2.0 SEMANTIQUE uniquement (voir regles ci-dessous)
    }
  ],
  "lacunes": [string]               // informations manquantes a recueillir lors d'un prochain entretien
}

REGLES POUR bpmn_xml (TRES IMPORTANT) :
- Genere du BPMN 2.0 SEMANTIQUE valide, SANS aucune section de mise en page (PAS de bpmndi:BPMNDiagram, PAS de coordonnees). La mise en page est calculee automatiquement cote client.
- Structure : un seul <bpmn:process> par processus, contenant UN startEvent, des tasks (bpmn:task), des passerelles si necessaire (bpmn:exclusiveGateway), UN ou plusieurs endEvent, et des sequenceFlow reliant le tout.
- Les noms (attribut name) doivent etre en francais, concis et explicites. Pour une tache, prefixe ou suffixe par l'acteur si pertinent (ex : name="Valider la commande (ADV)").
- Chaque element a un id unique stable (ex StartEvent_1, Task_1, Gateway_1, EndEvent_1, Flow_1). Chaque sequenceFlow a sourceRef et targetRef valides. Les passerelles exclusives ont des flux nommes (ex name="Conforme" / "Non conforme").
- N'utilise PAS de lanes ni de collaboration (un seul process plat) pour garantir la mise en page automatique.
- Namespaces a utiliser exactement :
  <bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_X" targetNamespace="http://bpmn.io/schema/bpmn">
    <bpmn:process id="Process_X" isExecutable="false"> ... </bpmn:process>
  </bpmn:definitions>
- Le BPMN doit refleter le deroulement reel decrit, pas un modele generique.

Consignes generales :
- N'invente pas de faits non evoques ; si une donnee manque, laisse la chaine vide ou liste-la dans "lacunes".
- Identifie TOUS les processus distincts mentionnes (vente, achat, production, logistique, RH, qualite, maintenance, finance, etc.) selon ce que dit l'interviewe.
- Reste fidele au vocabulaire de l'entreprise.
- Reponds en francais.`;
}

function buildDossierUserPrompt({ transcript, guide, meta, previousDossier }) {
  const m = meta || {};
  const entete = [
    m.entreprise ? `Entreprise : ${m.entreprise}` : null,
    m.interlocuteur ? `Interlocuteur : ${m.interlocuteur}` : null,
    m.date ? `Date : ${m.date}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const anterieur = previousDossier
    ? `=== DOSSIER ANTERIEUR (a mettre a jour, ne pas repartir de zero) ===
${JSON.stringify(previousDossier)}

`
    : "";

  return `${entete ? entete + "\n\n" : ""}${anterieur}=== GUIDE D'INTERVIEW UTILISE ===
${guide || "(non fourni)"}

=== TRANSCRIPTION DE LA NOUVELLE INTERVIEW ===
${transcript}

=== FIN ===
${previousDossier
  ? "Produis maintenant le dossier JSON A JOUR (fusion du dossier anterieur et des nouvelles informations), conforme au schema."
  : "Produis maintenant le dossier JSON conforme au schema."}`;
}
