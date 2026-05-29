/* Rendu du dossier de cartographie + diagrammes BPMN.
   bpmn-js (viewer) et bpmn-auto-layout sont charges en ESM depuis un CDN.
   Le modele ne genere que du BPMN SEMANTIQUE ; la mise en page (coordonnees)
   est calculee ici par bpmn-auto-layout avant le rendu par bpmn-js. */

/* Librairies BPMN VENDORISEES localement (public/vendor/), bundlees via esbuild.
   Avantages vs CDN : aucune dependance reseau pour le rendu (les proxys
   d'entreprise bloquent souvent esm.sh/jsdelivr), versions figees, demarrage
   instantane, fonctionne en app de bureau autonome. */
const VIEWER_URL = "/vendor/bpmn-js.viewer.bundle.js";
const LAYOUT_URL = "/vendor/bpmn-auto-layout.bundle.js";
let _viewerMod = null;
let _layoutMod = null;

async function loadBpmnLibs() {
  if (_viewerMod && _layoutMod) return;
  [_viewerMod, _layoutMod] = await Promise.all([
    import(VIEWER_URL),
    import(LAYOUT_URL),
  ]);
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function tagList(arr) {
  if (!arr || !arr.length) return '<span class="muted">—</span>';
  return `<div class="taglist">${arr.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>`;
}

function metaItem(k, v) {
  return `<div class="meta-item"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`;
}

export async function renderDossier(dossier, container) {
  const ent = dossier.entreprise || {};
  const carto = dossier.cartographie || {};
  const procs = Array.isArray(dossier.processus) ? dossier.processus : [];

  const cartoCol = (titre, items) => `
    <div class="carto-col">
      <h4>${esc(titre)}</h4>
      <ul>${(items || []).map((i) => `<li>${esc(i)}</li>`).join("") || "<li class='muted'>—</li>"}</ul>
    </div>`;

  let html = `
    <h1>${esc(ent.nom || "Cartographie des processus")}</h1>
    <p class="entreprise-head">
      ${[ent.secteur, ent.effectif].filter(Boolean).map(esc).join(" · ")}
    </p>
    ${ent.synthese ? `<p>${esc(ent.synthese)}</p>` : ""}

    <h2>Cartographie d'ensemble</h2>
    <div class="carto-grid">
      ${cartoCol("Management", carto.management)}
      ${cartoCol("Realisation", carto.realisation)}
      ${cartoCol("Support", carto.support)}
    </div>

    <h2>Fiches processus (${procs.length})</h2>
  `;

  procs.forEach((p, idx) => {
    html += renderFiche(p, idx);
  });

  if (Array.isArray(dossier.lacunes) && dossier.lacunes.length) {
    html += `
      <h2>Points a approfondir</h2>
      <div class="lacunes">
        <strong>Informations manquantes ou a confirmer lors d'un prochain entretien :</strong>
        <ul>${dossier.lacunes.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
      </div>`;
  }

  container.innerHTML = html;

  // Rendu des diagrammes BPMN apres injection du HTML
  await renderAllBpmn(procs);
}

function renderFiche(p, idx) {
  const cat = (p.categorie || "realisation").toLowerCase();
  const steps = Array.isArray(p.etapes) ? [...p.etapes].sort((a, b) => (a.ordre || 0) - (b.ordre || 0)) : [];

  const stepsHtml = steps.length
    ? `<details open>
         <summary>Etapes detaillees (${steps.length})</summary>
         <ol class="steps">
           ${steps
             .map(
               (s) =>
                 `<li class="${s.type === "decision" ? "decision" : ""}"><strong>${esc(s.nom)}</strong>${
                   s.acteur ? ` <em>(${esc(s.acteur)})</em>` : ""
                 }${s.description ? ` — ${esc(s.description)}` : ""}</li>`
             )
             .join("")}
         </ol>
       </details>`
    : "";

  return `
    <div class="fiche" id="fiche-${idx}">
      <div class="fiche-head">
        <span class="badge ${cat}">${esc(p.categorie || "")}</span>
        <span class="pid">${esc(p.id || "")}</span>
        <h3>${esc(p.nom || "Processus")}</h3>
      </div>
      ${p.objectif ? `<p>${esc(p.objectif)}</p>` : ""}

      <div class="meta-grid">
        ${metaItem("Declencheur", esc(p.declencheur) || "—")}
        ${metaItem("Resultat", esc(p.resultat) || "—")}
        ${metaItem("Acteurs", tagList(p.acteurs))}
        ${metaItem("Applications", tagList(p.applications))}
        ${metaItem("Entrees", tagList(p.entrees))}
        ${metaItem("Sorties", tagList(p.sorties))}
        ${metaItem("Regles de gestion", tagList(p.regles_gestion))}
        ${metaItem("Indicateurs (KPI)", tagList(p.kpis))}
        ${metaItem("Irritants / risques", tagList(p.irritants))}
        ${metaItem("Volumetrie", esc(p.volumetrie) || "—")}
      </div>

      ${stepsHtml}

      <div class="bpmn-box" id="bpmn-${idx}" data-bpmn="${idx}"></div>
    </div>`;
}

async function renderAllBpmn(procs) {
  const withXml = procs
    .map((p, idx) => ({ p, idx }))
    .filter(({ p }) => p.bpmn_xml && p.bpmn_xml.trim());

  if (!withXml.length) return;

  try {
    await loadBpmnLibs();
  } catch (e) {
    console.error("Chargement bpmn-js impossible:", e);
    const detail = (e && e.message ? e.message : String(e)).slice(0, 140);
    withXml.forEach(({ idx }) =>
      bpmnFallback(idx, "Librairie de diagramme indisponible. Detail : " + detail)
    );
    return;
  }

  const Viewer = _viewerMod.default || _viewerMod.Viewer;
  const layoutProcess = _layoutMod.layoutProcess || _layoutMod.default;
  if (typeof Viewer !== "function" || typeof layoutProcess !== "function") {
    console.error("Exports BPMN inattendus", { viewer: _viewerMod, layout: _layoutMod });
    withXml.forEach(({ idx }) => bpmnFallback(idx, "Module BPMN charge mais exports inattendus (voir console)."));
    return;
  }

  for (const { p, idx } of withXml) {
    const box = document.getElementById(`bpmn-${idx}`);
    if (!box) continue;
    try {
      const semantic = sanitizeBpmn(p.bpmn_xml);
      const laidOut = await layoutProcess(semantic);
      const viewer = new Viewer({ container: box });
      await viewer.importXML(laidOut);
      // Le diagramme est importe : on l'ajuste a la vue. Le zoom est isole
      // dans son propre try car "fit-viewport" peut lever
      // "SVGMatrix scale non-finite" si le conteneur n'est pas encore mesure
      // (largeur/hauteur 0). Dans ce cas le diagramme reste affiche, on
      // re-essaie au frame suivant une fois la mise en page stabilisee.
      await fitViewport(viewer, box);
    } catch (e) {
      console.error(`BPMN process ${idx} echec:`, e);
      bpmnFallback(idx, "Le diagramme n'a pas pu etre genere automatiquement. Les etapes detaillees ci-dessus restent disponibles.");
    }
  }
}

/* Ajuste le diagramme a la vue de maniere robuste : attend que le conteneur
   ait une taille mesurable avant d'appeler fit-viewport, et n'echoue jamais
   l'affichage du diagramme pour une simple erreur de zoom. */
function fitViewport(viewer, box, attempt = 0) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      const ready = box.clientWidth > 0 && box.clientHeight > 0;
      if (!ready && attempt < 10) {
        // Conteneur pas encore dimensionne : on re-essaie au frame suivant.
        fitViewport(viewer, box, attempt + 1).then(resolve);
        return;
      }
      try {
        const canvas = viewer.get("canvas");
        canvas.zoom("fit-viewport", "auto");
      } catch (e) {
        // Le diagramme est deja rendu ; un echec de zoom ne doit pas le
        // masquer. On laisse le SVG tel quel (visible, eventuellement non centre).
        console.warn("zoom fit-viewport ignore:", e && e.message ? e.message : e);
      }
      resolve();
    });
  });
}

/* Nettoie les artefacts frequents : fences markdown, espaces, DI parasite. */
function sanitizeBpmn(xml) {
  let s = String(xml).trim();
  s = s.replace(/^```(?:xml)?\s*/i, "").replace(/```\s*$/i, "").trim();
  // si le modele a malgre tout ajoute un diagramme DI, on le retire (auto-layout le recree)
  s = s.replace(/<bpmndi:BPMNDiagram[\s\S]*?<\/bpmndi:BPMNDiagram>/g, "");
  return s;
}

function bpmnFallback(idx, msg) {
  const box = document.getElementById(`bpmn-${idx}`);
  if (box) {
    box.style.height = "auto";
    box.style.background = "transparent";
    box.style.border = "none";
    box.innerHTML = `<p class="bpmn-fallback">⚠️ ${esc(msg)}</p>`;
  }
}
