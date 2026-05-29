/* Entrypoint MODE WEB standalone (sans Electron).
   Lance le serveur Express avec la cle lue depuis l'environnement (.env).
   Usage : npm start  (ou node web.js)
   Le mode Electron, lui, importe startServer() directement et fournit
   sa propre fonction getApiKey() basee sur le coffre securise de l'OS. */
import dotenv from "dotenv";
import { startServer } from "./server.js";

dotenv.config();

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.warn(
    "\n⚠️  OPENAI_API_KEY absente. Copie .env.example vers .env et renseigne ta cle.\n"
  );
}

const { port } = await startServer({
  port: PORT,
  getApiKey: () => process.env.OPENAI_API_KEY,
});

console.log(`\n🎙️  ProcesInterViewer (mode web) en ecoute sur http://localhost:${port}`);
console.log(
  `   Realtime: ${process.env.REALTIME_MODEL || "gpt-realtime"} | Voix: ${
    process.env.REALTIME_VOICE || "marin"
  } | Dossier: ${process.env.DOSSIER_MODEL || "gpt-4o"}`
);
if (!OPENAI_API_KEY) {
  console.log("   (Configure OPENAI_API_KEY dans .env avant de lancer une interview)\n");
}
