/* Stockage local des sessions d'interview (historique consultable + versionne).
   Un fichier JSON par session dans <dataDir>/history/. Aucun module natif :
   fonctionne a l'identique en mode web et en Electron, facile a sauvegarder.

   VERSIONING : une "lignee" (lineageId) regroupe toutes les versions
   successives d'une meme cartographie d'entreprise. Enrichir une interview
   existante cree une NOUVELLE version reliee (meme lineageId, version+1) ;
   la plus recente fait foi. L'historique n'affiche que la derniere version
   de chaque lignee, mais conserve toutes les versions (tracabilite).

   Chaque session contient : metadonnees, guide, transcription, dossier,
   et les champs de lignage (lineageId, version, parentId). */
import { mkdir, readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/* Empeche toute traversee de chemin via un id manipule. */
function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9-]/g, "");
}

export function createStore(dataDir) {
  const dir = join(dataDir, "history");
  const ready = mkdir(dir, { recursive: true }).catch(() => {});

  /* Enregistre une session.
     - parentId fourni => nouvelle version d'une lignee existante.
     - sinon => nouvelle lignee (version 1). */
  async function save({ meta, guide, transcript, dossier, parentId }) {
    await ready;
    const id = randomUUID();
    const createdAt = new Date().toISOString();

    let lineageId = id;
    let version = 1;
    if (parentId) {
      const parent = await get(parentId);
      if (parent) {
        lineageId = parent.lineageId || parent.id;
        version = (parent.version || 1) + 1;
      }
    }

    const record = {
      id,
      lineageId,
      version,
      parentId: parentId || null,
      createdAt,
      meta: meta || {},
      guide: guide || "",
      transcript: transcript || "",
      dossier: dossier || {},
    };
    await writeFile(join(dir, id + ".json"), JSON.stringify(record), "utf8");
    return { id, lineageId, version, createdAt };
  }

  /* Charge tous les enregistrements bruts (usage interne). */
  async function readAll() {
    await ready;
    let files;
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const recs = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        recs.push(JSON.parse(await readFile(join(dir, f), "utf8")));
      } catch {
        /* fichier illisible : ignore */
      }
    }
    return recs;
  }

  function summarize(rec) {
    const d = rec.dossier || {};
    return {
      id: rec.id,
      lineageId: rec.lineageId || rec.id,
      version: rec.version || 1,
      createdAt: rec.createdAt,
      entreprise:
        (d.entreprise && d.entreprise.nom) ||
        (rec.meta && rec.meta.entreprise) ||
        "Sans nom",
      interlocuteur: (rec.meta && rec.meta.interlocuteur) || "",
      secteur: (d.entreprise && d.entreprise.secteur) || "",
      nbProcessus: Array.isArray(d.processus) ? d.processus.length : 0,
    };
  }

  /* Liste pour l'ecran Historique : UNE entree par lignee (derniere version),
     triee du plus recent. */
  async function list() {
    const recs = await readAll();
    const latestByLineage = new Map();
    for (const rec of recs) {
      const lin = rec.lineageId || rec.id;
      const cur = latestByLineage.get(lin);
      if (!cur || (rec.version || 1) > (cur.version || 1)) {
        latestByLineage.set(lin, rec);
      }
    }
    const out = [...latestByLineage.values()].map(summarize);
    out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return out;
  }

  /* Historique des versions d'une lignee (de la plus recente a la plus ancienne). */
  async function versions(lineageId) {
    const recs = await readAll();
    return recs
      .filter((r) => (r.lineageId || r.id) === lineageId)
      .sort((a, b) => (b.version || 1) - (a.version || 1))
      .map(summarize);
  }

  async function get(id) {
    await ready;
    try {
      return JSON.parse(await readFile(join(dir, safeId(id) + ".json"), "utf8"));
    } catch {
      return null;
    }
  }

  async function remove(id) {
    await ready;
    try {
      await unlink(join(dir, safeId(id) + ".json"));
      return true;
    } catch {
      return false;
    }
  }

  return { save, list, versions, get, remove, dir };
}
