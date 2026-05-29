import { renderDossier } from "/dossier.js";

/* ---------------- Etat global ---------------- */
const state = {
  pc: null, // RTCPeerConnection
  dc: null, // data channel
  micStream: null,
  audioEl: null,
  muted: false,
  startTime: 0,
  timerId: null,
  // transcript : liste ordonnee { role, text }
  turns: [],
  // buffers en cours de construction par item_id
  partial: new Map(),
  // enrichissement : session source choisie (dossier anterieur), ou null
  baseSession: null,
};

const els = {
  screens: {
    config: document.getElementById("screen-config"),
    setup: document.getElementById("screen-setup"),
    history: document.getElementById("screen-history"),
    interview: document.getElementById("screen-interview"),
    building: document.getElementById("screen-building"),
    dossier: document.getElementById("screen-dossier"),
  },
  historyBtn: document.getElementById("historyBtn"),
  historyBtn2: document.getElementById("historyBtn2"),
  historyBackBtn: document.getElementById("historyBackBtn"),
  historyList: document.getElementById("historyList"),
  historyEmpty: document.getElementById("historyEmpty"),
  apiKeyInput: document.getElementById("apiKeyInput"),
  saveKeyBtn: document.getElementById("saveKeyBtn"),
  configError: document.getElementById("configError"),
  configHint: document.getElementById("configHint"),
  settingsLink: document.getElementById("settingsLink"),
  changeKeyLink: document.getElementById("changeKeyLink"),
  baseSelect: document.getElementById("baseSelect"),
  baseInfo: document.getElementById("baseInfo"),
  suggestion: document.getElementById("suggestion"),
  entreprise: document.getElementById("entreprise"),
  interlocuteur: document.getElementById("interlocuteur"),
  guideSelect: document.getElementById("guideSelect"),
  guideText: document.getElementById("guideText"),
  guideFile: document.getElementById("guideFile"),
  startBtn: document.getElementById("startBtn"),
  setupError: document.getElementById("setupError"),
  orb: document.getElementById("orb"),
  statusText: document.getElementById("statusText"),
  timer: document.getElementById("timer"),
  transcript: document.getElementById("transcript"),
  muteBtn: document.getElementById("muteBtn"),
  endBtn: document.getElementById("endBtn"),
  printBtn: document.getElementById("printBtn"),
  downloadJsonBtn: document.getElementById("downloadJsonBtn"),
  restartBtn: document.getElementById("restartBtn"),
  dossierContent: document.getElementById("dossierContent"),
};

function showScreen(name) {
  for (const [k, el] of Object.entries(els.screens)) el.hidden = k !== name;
}

/* ---------------- Chargement des guides ---------------- */
async function loadGuides() {
  try {
    const list = await (await fetch("/api/guides")).json();
    els.guideSelect.innerHTML = "";
    if (!list.length) {
      const opt = document.createElement("option");
      opt.textContent = "(aucun guide trouve — collez le votre ci-dessous)";
      opt.value = "";
      els.guideSelect.appendChild(opt);
      return;
    }
    for (const f of list) {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = f.replace(/\.md$/i, "").replace(/[-_]/g, " ");
      els.guideSelect.appendChild(opt);
    }
    await loadGuideContent(list[0]);
  } catch (e) {
    console.error(e);
  }
}

async function loadGuideContent(filename) {
  if (!filename) return;
  try {
    const txt = await (await fetch(`/guides/${encodeURIComponent(filename)}`)).text();
    els.guideText.value = txt;
  } catch (e) {
    console.error(e);
  }
}

els.guideSelect.addEventListener("change", (e) => loadGuideContent(e.target.value));
els.guideFile.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  els.guideText.value = await file.text();
  els.guideSelect.value = "";
});

/* ---------------- Menu "Partir de" (enrichissement incremental) ---------------- */
let historyCache = []; // resumes des interviews existantes

async function loadBaseOptions() {
  try {
    historyCache = await (await fetch("/api/history")).json();
  } catch {
    historyCache = [];
  }
  // Reconstruit le menu : "Nouvelle" + une entree par interview existante.
  els.baseSelect.innerHTML = '<option value="">🆕 Nouvelle interview</option>';
  for (const s of historyCache) {
    const opt = document.createElement("option");
    opt.value = s.id;
    const v = s.version && s.version > 1 ? ` v${s.version}` : "";
    opt.textContent = `↻ ${s.entreprise}${v} — ${s.nbProcessus} process`;
    els.baseSelect.appendChild(opt);
  }
}

// Selection explicite d'une base dans le menu
els.baseSelect.addEventListener("change", () => selectBase(els.baseSelect.value));

async function selectBase(id) {
  els.suggestion.hidden = true;
  if (!id) {
    state.baseSession = null;
    els.baseInfo.hidden = true;
    return;
  }
  try {
    const rec = await (await fetch("/api/history/" + encodeURIComponent(id))).json();
    if (!rec || !rec.dossier) throw new Error("introuvable");
    state.baseSession = rec;
    els.baseSelect.value = id;
    // Pre-remplit l'entreprise et signale le mode enrichissement
    const nom = rec.dossier.entreprise?.nom || rec.meta?.entreprise || "";
    if (nom) els.entreprise.value = nom;
    const nb = Array.isArray(rec.dossier.processus) ? rec.dossier.processus.length : 0;
    els.baseInfo.textContent = `Mode enrichissement : ${nb} processus deja cartographies. L'intervieweur ne reposera que les questions utiles (manques, changements, nouveaux process).`;
    els.baseInfo.hidden = false;
  } catch {
    state.baseSession = null;
  }
}

// Suggestion automatique quand le nom saisi correspond a une interview connue
els.entreprise.addEventListener("input", () => {
  if (state.baseSession) return; // deja en mode enrichissement
  const val = els.entreprise.value.trim().toLowerCase();
  els.suggestion.hidden = true;
  if (val.length < 3) return;
  const match = historyCache.find(
    (s) => (s.entreprise || "").toLowerCase().includes(val) || val.includes((s.entreprise || "").toLowerCase())
  );
  if (match) {
    els.suggestion.innerHTML =
      `Une interview existe deja pour « ${match.entreprise} ». ` +
      `<a id="useExisting">Continuer / enrichir celle-ci</a> au lieu d'en creer une nouvelle ?`;
    els.suggestion.hidden = false;
    const link = document.getElementById("useExisting");
    if (link) link.addEventListener("click", () => selectBase(match.id));
  }
});

/* ---------------- Demarrage de l'interview ---------------- */
els.startBtn.addEventListener("click", startInterview);

async function startInterview() {
  els.setupError.hidden = true;
  const guide = els.guideText.value.trim();
  if (!guide) {
    return showError("Merci de fournir un guide d'interview (Markdown).");
  }
  els.startBtn.disabled = true;
  els.startBtn.textContent = "Connexion…";

  try {
    // 1. Jeton ephemere
    const tokenResp = await fetch("/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || !tokenData.value) {
      throw new Error(tokenData.error || "Impossible d'obtenir un jeton.");
    }
    const EPHEMERAL_KEY = tokenData.value;

    // 2. Micro
    state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // 3. RTCPeerConnection
    const pc = new RTCPeerConnection();
    state.pc = pc;

    // audio distant (voix de l'IA)
    state.audioEl = document.createElement("audio");
    state.audioEl.autoplay = true;
    pc.ontrack = (e) => {
      state.audioEl.srcObject = e.streams[0];
    };

    pc.addTrack(state.micStream.getTracks()[0]);

    // data channel pour les evenements
    const dc = pc.createDataChannel("oai-events");
    state.dc = dc;
    dc.addEventListener("open", () => onDataChannelOpen(guide));
    dc.addEventListener("message", (e) => handleServerEvent(JSON.parse(e.data)));

    pc.addEventListener("connectionstatechange", () => {
      if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
        setStatus("Connexion interrompue", "");
      }
    });

    // 4. Offre SDP -> OpenAI
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpResp = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${EPHEMERAL_KEY}`,
        "Content-Type": "application/sdp",
      },
    });
    if (!sdpResp.ok) {
      throw new Error("Echec de la negociation WebRTC (" + sdpResp.status + ").");
    }
    const answer = { type: "answer", sdp: await sdpResp.text() };
    await pc.setRemoteDescription(answer);

    // Bascule d'ecran
    showScreen("interview");
    setStatus("A l'ecoute…", "listening");
    startTimer();
  } catch (err) {
    console.error(err);
    showError(err.message || String(err));
    els.startBtn.disabled = false;
    els.startBtn.textContent = "Demarrer l'interview";
    cleanupConnection();
  }
}

function showError(msg) {
  els.setupError.textContent = msg;
  els.setupError.hidden = false;
}

/* ---------------- Configuration session + 1ere question ---------------- */
function onDataChannelOpen(guide) {
  const entreprise = els.entreprise.value.trim();
  const interlocuteur = els.interlocuteur.value.trim();
  const base = state.baseSession;

  const instructions = buildInterviewerInstructions({ guide, entreprise, interlocuteur, base });

  // Configure la session : instructions, transcription de l'entree, VAD
  send({
    type: "session.update",
    session: {
      type: "realtime",
      instructions,
      audio: {
        input: {
          transcription: { model: "whisper-1" },
          turn_detection: { type: "server_vad", silence_duration_ms: 800 },
        },
      },
    },
  });

  // Demande a l'IA de demarrer : accueil + 1ere question adaptee au mode.
  const openingInstructions = base
    ? "Accueille brievement la personne (1 phrase) et rappelle qu'on REPREND la cartographie deja etablie pour la mettre a jour. Resume en une phrase ce qui est deja connu (cite 2-3 processus deja cartographies). Puis demande ce qui a CHANGE depuis, ce qu'on n'avait PAS encore vu, ou s'il y a un process precis a revoir. Ne repose PAS les questions de base sur les process deja documentes, sauf si la personne souhaite y revenir."
    : "Accueille brievement la personne (1 phrase), explique en une phrase le but (cartographier les processus de l'entreprise), puis propose IMMEDIATEMENT un point de depart concret en citant 3-4 processus types pertinents pour cette activite (un produit a suivre du devis a la pose, ou un processus precis comme achats/vente/stock, ou une activite quotidienne) et demande lequel lui parle le plus. Ne pose PAS de question ouverte et vague.";
  send({
    type: "response.create",
    response: { instructions: openingInstructions },
  });
}

function buildPriorContext(base) {
  if (!base || !base.dossier) return "";
  const d = base.dossier;
  const procs = Array.isArray(d.processus) ? d.processus : [];
  const lignes = procs.map((p) => {
    const etapes = Array.isArray(p.etapes) ? p.etapes.length : 0;
    return `- ${p.nom || p.id}${p.objectif ? " : " + p.objectif : ""} (${etapes} etapes documentees)`;
  });
  const lacunes = Array.isArray(d.lacunes) && d.lacunes.length
    ? `\nPoints encore a approfondir (priorite pour cet entretien) :\n` + d.lacunes.map((l) => `- ${l}`).join("\n")
    : "";
  return `

=== CARTOGRAPHIE DEJA ETABLIE (entretiens precedents) ===
Tu REPRENDS une cartographie existante pour la METTRE A JOUR de maniere incrementale.
Processus deja documentes (NE PAS reposer les questions de base dessus, sauf si la personne veut y revenir ou signale un changement) :
${lignes.join("\n") || "(aucun)"}${lacunes}

REGLE DU MODE MISE A JOUR :
- Concentre-toi sur : ce qui a CHANGE, ce qui n'a PAS encore ete vu, les NOUVEAUX processus, et les points a approfondir listes ci-dessus.
- Pour un processus deja documente, demande juste s'il y a du nouveau ou une correction ; ne le re-deroule en entier QUE si la personne le souhaite.
- Si la personne veut explicitement revenir sur un sujet deja vu, fais-le volontiers.
=== FIN CARTOGRAPHIE EXISTANTE ===`;
}

function buildInterviewerInstructions({ guide, entreprise, interlocuteur, base }) {
  return `Tu es un consultant en organisation qui mene une interview vocale, en FRANCAIS, pour cartographier l'ENSEMBLE des processus metier d'une entreprise.

${entreprise ? `Entreprise interviewee : ${entreprise}.` : ""}
${interlocuteur ? `Interlocuteur : ${interlocuteur}.` : ""}
${buildPriorContext(base)}

STYLE :
- Parle naturellement, avec chaleur et professionnalisme. Phrases courtes.
- Pose UNE seule question a la fois, puis ECOUTE. Ne monopolise jamais la parole.
- NE reformule PAS systematiquement. Enchaine directement sur la question suivante. Ne reformule que si c'est VRAIMENT utile : reponse ambigue, chiffre/regle importants a confirmer, ou point complexe que tu dois t'assurer d'avoir bien compris. Le reste du temps, un simple acquiescement bref suffit ("d'accord", "ok") avant de creuser ou de passer a la suite.
- Rebondis sur les reponses : creuse les details concrets.

OBJECTIF DE COLLECTE — pour CHAQUE processus evoque, tu dois obtenir :
- le declencheur (ce qui lance le processus) et le resultat final,
- les etapes dans l'ordre, et qui fait quoi (acteurs/roles),
- les entrees/sorties (documents, donnees),
- les outils/logiciels utilises,
- les regles de gestion, controles et points de decision,
- la volumetrie/frequence,
- les irritants, risques et pistes d'amelioration.

DEROULE :
- Suis le guide d'interview ci-dessous comme fil conducteur, mais adapte-toi aux reponses.
- ENTREE EN MATIERE CONCRETE : ne demande JAMAIS de maniere ouverte et vague "quel processus voulez-vous decrire ?". A la place, propose d'emblee un point de depart en citant 3 ou 4 processus types PERTINENTS pour l'activite de cette entreprise (deduits du guide et du contexte). Exemple pour une menuiserie : "Par quoi voulez-vous commencer ? On peut partir d'un produit que vous fabriquez et suivre son parcours du devis a la pose ; ou prendre un processus precis comme les achats, la vente, la gestion des stocks ; ou encore une activite que vous realisez au quotidien. Qu'est-ce qui vous parle le plus ?". Adapte ces exemples au metier reel (scierie : appro grume, sciage, sechage, expedition ; etc.).
- Une fois le point de depart choisi, deroule ce processus en profondeur AVANT de passer au suivant. Pour passer a la suite, propose toi-meme le processus logiquement lie (amont/aval) plutot que de reposer une question ouverte.
- Couvre progressivement tous les grands domaines : pilotage/management, coeur de metier (realisation), et support (RH, achats, qualite, maintenance, finance, SI...).
- Avance a un rythme confortable. Quand un processus est suffisamment decrit, passe au suivant.
- Quand tu estimes avoir fait le tour, fais une courte synthese orale, demande s'il manque un processus, puis invite la personne a cliquer sur le bouton "Terminer l'interview" pour generer le dossier.

GUIDE D'INTERVIEW (Markdown) :
"""
${guide}
"""`;
}

/* ---------------- Reception des evenements serveur ---------------- */
function handleServerEvent(evt) {
  switch (evt.type) {
    // L'IA parle
    case "output_audio_buffer.started":
    case "response.output_audio.started":
      setStatus("L'intervieweur parle…", "speaking");
      break;
    case "output_audio_buffer.stopped":
    case "response.done":
      setStatus("A vous…", "listening");
      break;

    // Transcript final de l'IA
    case "response.output_audio_transcript.done":
    case "response.audio_transcript.done":
      if (evt.transcript) addTurn("assistant", evt.transcript);
      break;

    // Transcription de ce que dit l'utilisateur
    case "conversation.item.input_audio_transcription.completed":
      if (evt.transcript) addTurn("user", evt.transcript.trim());
      break;

    case "error":
      console.error("Realtime error:", evt);
      break;
  }
}

/* ---------------- Transcript UI ---------------- */
function addTurn(role, text) {
  if (!text) return;
  state.turns.push({ role, text });

  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "assistant" ? "Intervieweur" : "Vous";
  div.appendChild(who);
  div.appendChild(document.createTextNode(text));
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

/* ---------------- Statut / timer ---------------- */
function setStatus(text, orbClass) {
  els.statusText.textContent = text;
  els.orb.className = "orb" + (orbClass ? " " + orbClass : "");
}
function startTimer() {
  state.startTime = Date.now();
  state.timerId = setInterval(() => {
    const s = Math.floor((Date.now() - state.startTime) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    els.timer.textContent = `${mm}:${ss}`;
  }, 1000);
}

/* ---------------- Mute ---------------- */
els.muteBtn.addEventListener("click", () => {
  state.muted = !state.muted;
  if (state.micStream) {
    state.micStream.getAudioTracks().forEach((t) => (t.enabled = !state.muted));
  }
  els.muteBtn.textContent = state.muted ? "🎤 Reactiver mon micro" : "🔇 Couper mon micro";
});

/* ---------------- Fin d'interview + generation dossier ---------------- */
els.endBtn.addEventListener("click", endInterview);

async function endInterview() {
  els.endBtn.disabled = true;
  if (state.timerId) clearInterval(state.timerId);

  const transcript = state.turns
    .map((t) => `${t.role === "assistant" ? "INTERVIEWEUR" : "INTERVIEWE"}: ${t.text}`)
    .join("\n");

  cleanupConnection();

  if (state.turns.length < 2) {
    alert("L'interview est trop courte pour generer un dossier.");
    showScreen("setup");
    els.endBtn.disabled = false;
    return;
  }

  showScreen("building");

  try {
    const resp = await fetch("/api/dossier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript,
        guide: els.guideText.value,
        meta: {
          entreprise: els.entreprise.value.trim(),
          interlocuteur: els.interlocuteur.value.trim(),
          date: new Date().toLocaleDateString("fr-FR"),
        },
        // Enrichissement : relie la nouvelle version a la session source.
        parentId: state.baseSession ? state.baseSession.id : undefined,
      }),
    });
    const dossier = await resp.json();
    if (!resp.ok) throw new Error(dossier.error || "Echec generation");

    state.lastDossier = dossier;
    await renderDossier(dossier, els.dossierContent);
    showScreen("dossier");
  } catch (err) {
    console.error(err);
    alert("Erreur lors de la generation du dossier : " + (err.message || err));
    showScreen("setup");
    els.endBtn.disabled = false;
  }
}

function cleanupConnection() {
  try { state.dc && state.dc.close(); } catch {}
  try { state.pc && state.pc.close(); } catch {}
  try { state.micStream && state.micStream.getTracks().forEach((t) => t.stop()); } catch {}
  state.dc = null;
  state.pc = null;
  state.micStream = null;
}

/* ---------------- Envoi data channel ---------------- */
function send(obj) {
  if (state.dc && state.dc.readyState === "open") {
    state.dc.send(JSON.stringify(obj));
  }
}

/* ---------------- Actions dossier ---------------- */
els.printBtn.addEventListener("click", () => window.print());
els.restartBtn.addEventListener("click", () => location.reload());
els.downloadJsonBtn.addEventListener("click", () => {
  if (!state.lastDossier) return;
  const blob = new Blob([JSON.stringify(state.lastDossier, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const nom = (state.lastDossier.entreprise?.nom || "entreprise").replace(/\s+/g, "-");
  a.download = `dossier-process-${nom}.json`;
  a.click();
});

/* ---------------- Historique des interviews ---------------- */
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleString("fr-FR", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso || "";
  }
}

async function openHistory() {
  showScreen("history");
  els.historyList.innerHTML = "";
  els.historyEmpty.hidden = true;
  let list = [];
  try {
    list = await (await fetch("/api/history")).json();
  } catch (e) {
    console.error(e);
  }
  if (!Array.isArray(list) || !list.length) {
    els.historyEmpty.hidden = false;
    return;
  }
  for (const s of list) {
    const item = document.createElement("div");
    item.className = "history-item";

    const main = document.createElement("div");
    main.className = "hi-main";
    const title = document.createElement("div");
    title.className = "hi-title";
    title.textContent = s.entreprise || "Sans nom";
    const sub = document.createElement("div");
    sub.className = "hi-sub";
    const vtxt = s.version && s.version > 1 ? ` · v${s.version}` : "";
    sub.textContent =
      fmtDate(s.createdAt) +
      vtxt +
      (s.interlocuteur ? " · " + s.interlocuteur : "") +
      (s.secteur ? " · " + s.secteur : "");
    main.appendChild(title);
    main.appendChild(sub);

    const count = document.createElement("span");
    count.className = "hi-count";
    count.textContent = s.nbProcessus + " process";

    // Bouton enrichir : revient a l'accueil avec cette session comme base.
    const enrich = document.createElement("button");
    enrich.className = "hi-del";
    enrich.title = "Enrichir / mettre a jour";
    enrich.textContent = "↻";
    enrich.addEventListener("click", async (e) => {
      e.stopPropagation();
      await selectBase(s.id);
      showScreen("setup");
    });

    const del = document.createElement("button");
    del.className = "hi-del";
    del.title = "Supprimer";
    del.textContent = "🗑️";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Supprimer definitivement cette interview ?")) return;
      try {
        await fetch("/api/history/" + encodeURIComponent(s.id), { method: "DELETE" });
      } catch {}
      await loadBaseOptions();
      openHistory();
    });

    main.addEventListener("click", () => openSession(s.id));
    count.addEventListener("click", () => openSession(s.id));

    item.appendChild(main);
    item.appendChild(enrich);
    item.appendChild(count);
    item.appendChild(del);
    els.historyList.appendChild(item);
  }
}

async function openSession(id) {
  showScreen("building");
  try {
    const rec = await (await fetch("/api/history/" + encodeURIComponent(id))).json();
    if (!rec || !rec.dossier) throw new Error("Session introuvable");
    state.lastDossier = rec.dossier;
    await renderDossier(rec.dossier, els.dossierContent);
    showScreen("dossier");
  } catch (e) {
    console.error(e);
    alert("Impossible d'ouvrir cette interview : " + (e.message || e));
    openHistory();
  }
}

if (els.historyBtn) els.historyBtn.addEventListener("click", openHistory);
if (els.historyBtn2) els.historyBtn2.addEventListener("click", openHistory);
if (els.historyBackBtn) els.historyBackBtn.addEventListener("click", () => showScreen("setup"));

/* ---------------- Configuration cle API (mode Electron) ---------------- */
const isElectron = Boolean(window.api && window.api.isElectron);

async function saveApiKey() {
  els.configError.hidden = true;
  const key = els.apiKeyInput.value.trim();
  if (!key || !key.startsWith("sk-")) {
    els.configError.textContent = "Cle invalide : elle doit commencer par \"sk-\".";
    els.configError.hidden = false;
    return;
  }
  els.saveKeyBtn.disabled = true;
  els.saveKeyBtn.textContent = "Enregistrement…";
  try {
    await window.api.setApiKey(key);
    els.apiKeyInput.value = "";
    // Verifie que la cle est bien lisible par le serveur avant de continuer,
    // puis recharge : l'amorcage detectera hasKey=true et affichera l'accueil.
    let hasKey = false;
    try {
      const cfg = await (await fetch("/api/config")).json();
      hasKey = Boolean(cfg.hasKey);
    } catch {}
    if (hasKey) {
      location.reload();
      return;
    }
    // La cle a ete ecrite mais le serveur ne la voit pas (cas rare : coffre OS
    // indisponible). On bascule quand meme vers l'accueil.
    showScreen("setup");
  } catch (e) {
    els.configError.textContent = "Echec de l'enregistrement : " + (e.message || e);
    els.configError.hidden = false;
  } finally {
    els.saveKeyBtn.disabled = false;
    els.saveKeyBtn.textContent = "Enregistrer";
  }
}

if (els.saveKeyBtn) els.saveKeyBtn.addEventListener("click", saveApiKey);
if (els.apiKeyInput) {
  els.apiKeyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveApiKey();
  });
}
if (els.changeKeyLink) {
  els.changeKeyLink.addEventListener("click", (e) => {
    e.preventDefault();
    showScreen("config");
  });
}

/* ---------------- Amorcage ---------------- */
async function init() {
  loadGuides();
  loadBaseOptions();

  if (isElectron) {
    // En Electron : le lien "Changer la cle" est disponible, et on affiche
    // l'ecran de config tant qu'aucune cle n'est enregistree.
    if (els.settingsLink) els.settingsLink.hidden = false;
    try {
      const secure = await window.api.isSecureStorage();
      if (!secure && els.configHint) {
        els.configHint.textContent =
          "⚠️ Stockage securise OS indisponible : la cle sera conservee en clair sur ce poste.";
      }
    } catch {}

    let hasKey = false;
    try {
      const cfg = await (await fetch("/api/config")).json();
      hasKey = Boolean(cfg.hasKey);
    } catch {}
    showScreen(hasKey ? "setup" : "config");
  } else {
    // Mode web : la cle vient du serveur (.env), pas d'ecran de config.
    showScreen("setup");
  }
}

init();
