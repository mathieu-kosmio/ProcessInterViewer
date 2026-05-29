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
};

const els = {
  screens: {
    setup: document.getElementById("screen-setup"),
    interview: document.getElementById("screen-interview"),
    building: document.getElementById("screen-building"),
    dossier: document.getElementById("screen-dossier"),
  },
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

  const instructions = buildInterviewerInstructions({ guide, entreprise, interlocuteur });

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

  // Demande a l'IA de demarrer (mot d'accueil + 1ere question)
  send({
    type: "response.create",
    response: {
      instructions:
        "Accueille brievement la personne, explique en une phrase le but (cartographier les processus de l'entreprise), puis pose ta toute premiere question.",
    },
  });
}

function buildInterviewerInstructions({ guide, entreprise, interlocuteur }) {
  return `Tu es un consultant en organisation qui mene une interview vocale, en FRANCAIS, pour cartographier l'ENSEMBLE des processus metier d'une entreprise.

${entreprise ? `Entreprise interviewee : ${entreprise}.` : ""}
${interlocuteur ? `Interlocuteur : ${interlocuteur}.` : ""}

STYLE :
- Parle naturellement, avec chaleur et professionnalisme. Phrases courtes.
- Pose UNE seule question a la fois, puis ECOUTE. Ne monopolise jamais la parole.
- Reformule brievement pour confirmer ta comprehension avant de passer au point suivant.
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
- Couvre systematiquement tous les grands domaines : pilotage/management, coeur de metier (realisation), et support (RH, achats, qualite, maintenance, finance, SI...).
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

/* ---------------- Init ---------------- */
loadGuides();
