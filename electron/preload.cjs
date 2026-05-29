/* Preload — CJS impératif (le projet est "type":"module", donc un .js
   serait traité en ESM, incompatible avec le preload sandboxé).
   Expose une API minimale et sûre au renderer via contextBridge. */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Indique si une cle API est deja enregistree
  hasApiKey: () => ipcRenderer.invoke("apikey:has"),
  // Indique si le stockage sera chiffre par l'OS
  isSecureStorage: () => ipcRenderer.invoke("apikey:secure"),
  // Enregistre / remplace la cle API
  setApiKey: (key) => ipcRenderer.invoke("apikey:set", key),
  // Permet au frontend de savoir qu'il tourne dans Electron
  isElectron: true,
});
