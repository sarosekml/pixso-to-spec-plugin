import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = path.join(projectRoot, "src", "pixso-to-spec-plugin");
const outputDir = path.join(projectRoot, "dist", "pixso-to-spec");

const [manifest, code, ui, icon] = await Promise.all([
  readFile(path.join(sourceDir, "manifest.json"), "utf8"),
  readFile(path.join(sourceDir, "code.js"), "utf8"),
  readFile(path.join(sourceDir, "ui.html"), "utf8"),
  readFile(path.join(sourceDir, "plugin-icon.png")),
]);

const iconDataUri = `data:image/png;base64,${icon.toString("base64")}`;
const bundledUi = ui.replace('src="plugin-icon.png"', `src="${iconDataUri}"`);

if (bundledUi === ui) {
  throw new Error("Could not inline plugin-icon.png into ui.html");
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(path.join(outputDir, "manifest.json"), manifest),
  writeFile(path.join(outputDir, "code.js"), code),
  writeFile(path.join(outputDir, "ui.html"), bundledUi),
  writeFile(path.join(outputDir, "plugin-icon.png"), icon),
]);

console.log(`Built Pixso plugin: ${outputDir}`);
