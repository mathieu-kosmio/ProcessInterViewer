/* Regenere les assets BPMN vendorises dans public/vendor/.
   A relancer apres une mise a jour de bpmn-js / bpmn-auto-layout.
   Usage : npm run vendor
   Necessite les devDeps : bpmn-js, bpmn-auto-layout, esbuild. */
import { build } from "esbuild";
import { mkdir, writeFile, rm, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "public", "vendor");
const tmp = join(root, ".vendor-src");

async function main() {
  await mkdir(join(vendor, "bpmn"), { recursive: true });
  await mkdir(tmp, { recursive: true });

  // 1. CSS + polices bpmn (structure preservee : bpmn-font/css + bpmn-font/font)
  const assets = join(root, "node_modules", "bpmn-js", "dist", "assets");
  await cp(join(assets, "diagram-js.css"), join(vendor, "bpmn", "diagram-js.css"));
  await cp(join(assets, "bpmn-js.css"), join(vendor, "bpmn", "bpmn-js.css"));
  await cp(join(assets, "bpmn-font"), join(vendor, "bpmn", "bpmn-font"), { recursive: true });

  // 2. Bundles JS autonomes (ESM)
  await writeFile(join(tmp, "entry-viewer.mjs"), 'import Viewer from "bpmn-js/lib/Viewer";\nexport default Viewer;\n');
  await writeFile(join(tmp, "entry-layout.mjs"), 'export { layoutProcess } from "bpmn-auto-layout";\n');

  await build({
    entryPoints: [join(tmp, "entry-viewer.mjs")],
    bundle: true, format: "esm", minify: true,
    outfile: join(vendor, "bpmn-js.viewer.bundle.js"),
  });
  await build({
    entryPoints: [join(tmp, "entry-layout.mjs")],
    bundle: true, format: "esm", minify: true,
    outfile: join(vendor, "bpmn-auto-layout.bundle.js"),
  });

  await rm(tmp, { recursive: true, force: true });
  console.log("✓ Assets BPMN vendorises dans public/vendor/");
}

main().catch((e) => { console.error(e); process.exit(1); });
