/* Stockage de la cle API OpenAI dans le coffre securise de l'OS.
   Utilise safeStorage (API native Electron) : Keychain (macOS),
   DPAPI (Windows), libsecret/kwallet (Linux). Aucune dependance native
   a compiler (contrairement a keytar).

   IMPORTANT : ne jamais appeler safeStorage avant app.whenReady()
   (le backend de chiffrement Linux n'est resolu qu'apres ready). */
import { app, safeStorage } from "electron";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

const credFile = () => join(app.getPath("userData"), "credentials.json");

/* Lit et dechiffre la cle. Renvoie null si absente ou illisible. */
export async function getApiKey() {
  try {
    const raw = JSON.parse(await readFile(credFile(), "utf8"));
    if (!raw || !raw.openaiKey) return null;
    if (raw.encrypted) {
      if (!safeStorage.isEncryptionAvailable()) return null;
      try {
        return safeStorage.decryptString(Buffer.from(raw.openaiKey, "base64"));
      } catch {
        // Dechiffrement impossible (ex : rebuild non signe macOS change
        // l'identite de l'app). On force une nouvelle saisie.
        return null;
      }
    }
    return raw.openaiKey; // fallback non chiffre (Linux sans keyring)
  } catch {
    return null;
  }
}

/* Chiffre (si possible) et persiste la cle. mode 0o600 = lecture proprietaire. */
export async function setApiKey(plain) {
  const key = String(plain || "").trim();
  if (!key) throw new Error("Cle vide.");

  const available = safeStorage.isEncryptionAvailable();
  const payload = available
    ? { encrypted: true, openaiKey: safeStorage.encryptString(key).toString("base64") }
    : { encrypted: false, openaiKey: key };

  await writeFile(credFile(), JSON.stringify(payload), { mode: 0o600 });
  return { encrypted: available };
}

export async function hasApiKey() {
  return Boolean(await getApiKey());
}

/* Indique si le stockage sera chiffre (pour avertir l'utilisateur). */
export function isSecureStorageAvailable() {
  return safeStorage.isEncryptionAvailable();
}
