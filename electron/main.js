/* Process principal Electron (ESM — le projet est "type":"module").
   - Embarque le serveur Express (server.js) sur un port localhost aleatoire.
   - Fournit la cle API via le coffre securise de l'OS (keystore.mjs).
   - Gere les permissions micro (macOS + couche Chromium).
   - Expose des IPC pour saisir/changer la cle depuis l'UI. */
import { app, BrowserWindow, ipcMain, systemPreferences, session, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { startServer } from "../server.js";
import { getApiKey, setApiKey, hasApiKey, isSecureStorageAvailable } from "./keystore.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow = null;
let serverInfo = null;

/* ------------------------------------------------------------------ */
/*  Permissions micro                                                  */
/* ------------------------------------------------------------------ */
async function ensureMicrophone() {
  // macOS : demande l'autorisation systeme (la pop-up native).
  if (process.platform === "darwin") {
    try {
      const status = systemPreferences.getMediaAccessStatus("microphone");
      if (status !== "granted") {
        await systemPreferences.askForMediaAccess("microphone");
      }
    } catch (e) {
      console.warn("askForMediaAccess a echoue:", e);
    }
  }

  // Couche Chromium (les 3 OS) : Electron refuse par defaut les requetes
  // media d'origine non-file. On autorise micro/media pour notre origine
  // localhost (contexte securise car loopback).
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "microphone");
  });
  ses.setPermissionCheckHandler((_wc, permission) => {
    return permission === "media" || permission === "microphone";
  });
}

/* ------------------------------------------------------------------ */
/*  Fenetre principale                                                 */
/* ------------------------------------------------------------------ */
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "ProcesInterViewer",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Ouvre les liens externes (ex : cible _blank) dans le navigateur systeme.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${serverInfo.port}/`);
}

/* ------------------------------------------------------------------ */
/*  IPC : gestion de la cle API depuis l'UI                            */
/* ------------------------------------------------------------------ */
ipcMain.handle("apikey:has", () => hasApiKey());
ipcMain.handle("apikey:secure", () => isSecureStorageAvailable());
ipcMain.handle("apikey:set", async (_e, key) => {
  await setApiKey(key);
  return { ok: true };
});

/* ------------------------------------------------------------------ */
/*  Cycle de vie                                                       */
/* ------------------------------------------------------------------ */
app.whenReady().then(async () => {
  await ensureMicrophone();
  // Le serveur lit la cle via getApiKey() (coffre OS) a chaque requete.
  // L'historique des sessions est stocke dans userData (persiste entre maj).
  serverInfo = await startServer({ getApiKey, dataDir: app.getPath("userData") });
  console.log(`[ProcesInterViewer] serveur embarque sur http://127.0.0.1:${serverInfo.port}`);
  if (process.env.PIV_PORT_FILE) {
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(process.env.PIV_PORT_FILE, String(serverInfo.port));
    } catch {}
  }
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (serverInfo?.server) {
    try { serverInfo.server.close(); } catch {}
  }
  if (process.platform !== "darwin") app.quit();
});
