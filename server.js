import express from "express";
import dotenv from "dotenv";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";
const REALTIME_VOICE = process.env.REALTIME_VOICE || "marin";
const DOSSIER_MODEL = process.env.DOSSIER_MODEL || "gpt-4o";

if (!OPENAI_API_KEY) {
  console.warn(
    "\n⚠️  OPENAI_API_KEY absente. Copie .env.example vers .env et renseigne ta cle.\n"
  );
}

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.static(join(__dirname, "public")));
app.use("/guides", express.static(join(__dirname, "guides")));

/* ------------------------------------------------------------------ */
/*  1. Jeton ephemere pour la Realtime API (WebRTC cote navigateur)    */
/* ------------------------------------------------------------------ */
app.post("/api/token", async (req, res) => {
  if (!OPENAI_API_KEY) {
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
        Authorization: `Bearer ${OPENAI_API_KEY}`,
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

/* ------------------------------------------------------------------ */
/*  2. Liste des guides d'interview disponibles (dossier /guides)      */
/* ------------------------------------------------------------------ */
app.get("/api/guides", async (_req, res) => {
  try {
    const files = await readdir(join(__dirname, "guides"));
    res.json(files.filter((f) => f.toLowerCase().endsWith(".md")));
  } catch {
    res.json([]);
  }
});

/* ------------------------------------------------------------------ */
/*  3. Generation du dossier final (fiches process + BPMN semantique)  */
/* ------------------------------------------------------------------ */
app.post("/api/dossier", async (req, res) => {
  if (!OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY non configuree." });
  }
  const { transcript, guide, meta } = req.body || {};
  if (!transcript || !transcript.trim()) {
    return res.status(400).json({ error: "Transcript vide." });
  }

  const system = buildDossierSystemPrompt();
  const user = buildDossierUserPrompt({ transcript, guide, meta });

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
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
    res.json(dossier);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

/* ------------------------------------------------------------------ */
/*  Prompts                                                            */
/* ------------------------------------------------------------------ */
function buildDossierSystemPrompt() {
  return `Tu es un consultant senior en organisation et en cartographie des processus metier (approche type ISO 9001 / norme BPMN 2.0). On te fournit la transcription d'une interview vocale menee aupres d'une entreprise, ainsi que le guide d'interview utilise. Ta mission : produire un DOSSIER COMPLET et structure cartographiant l'ensemble des processus metier evoques.

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

function buildDossierUserPrompt({ transcript, guide, meta }) {
  const m = meta || {};
  const entete = [
    m.entreprise ? `Entreprise : ${m.entreprise}` : null,
    m.interlocuteur ? `Interlocuteur : ${m.interlocuteur}` : null,
    m.date ? `Date : ${m.date}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `${entete ? entete + "\n\n" : ""}=== GUIDE D'INTERVIEW UTILISE ===
${guide || "(non fourni)"}

=== TRANSCRIPTION DE L'INTERVIEW ===
${transcript}

=== FIN ===
Produis maintenant le dossier JSON conforme au schema.`;
}

/* Config publique consommee par le frontend (sans secret) */
app.get("/api/config", (_req, res) => {
  res.json({
    model: REALTIME_MODEL,
    voice: REALTIME_VOICE,
    hasKey: Boolean(OPENAI_API_KEY),
  });
});

app.listen(PORT, () => {
  console.log(`\n🎙️  ProcesInterViewer en ecoute sur http://localhost:${PORT}`);
  console.log(`   Realtime: ${REALTIME_MODEL} | Voix: ${REALTIME_VOICE} | Dossier: ${DOSSIER_MODEL}`);
  if (!OPENAI_API_KEY) console.log("   (Configure OPENAI_API_KEY dans .env avant de lancer une interview)\n");
});
