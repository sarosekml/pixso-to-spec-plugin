import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(projectRoot, "dist", "pixso-to-spec");
const manifest = JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8"));
const code = await readFile(path.join(outputDir, manifest.main), "utf8");
const ui = await readFile(path.join(outputDir, manifest.ui), "utf8");

assert.equal(manifest.name, "Pixso to Spec");
assert.equal(manifest.main, "code.js");
assert.equal(manifest.ui, "ui.html");
assert.deepEqual(manifest.editorType, ["pixso"]);
await access(path.join(outputDir, manifest.icon));

new vm.Script(code, { filename: manifest.main });
assert.match(code, /pixso\.showUI\(__html__/);
assert.match(code, /pixso\.ui\.onmessage = function/);
assert.match(code, /pixso\.on\("selectionchange"/);
assert.match(code, /format: "JPG"/);
assert.match(code, /item-id=/);

assert.match(ui, /<title>Pixso to Spec<\/title>/);
assert.match(ui, /value="md"/);
assert.match(ui, /value="html"/);
assert.match(ui, /name="image-mode" value="embedded"/);
assert.match(ui, /name="image-mode" value="separate"/);
assert.match(ui, /name="image-mode" value="none"/);
assert.match(ui, /function buildZip\(files\)/);
assert.match(ui, /application\/zip/);
assert.match(ui, /data:image\/png;base64,/);
assert.doesNotMatch(ui, /src="plugin-icon\.png"/);
assert.doesNotMatch(ui, /Pixso MCP Connect|Connect Pixso to AI agent/);

const settingsIcon = ui.match(/id="settings-open"[\s\S]*?<svg[^>]*>([\s\S]*?)<\/svg>/);
assert.ok(settingsIcon, "settings button must contain its SVG icon");
assert.equal(
  (settingsIcon[1].match(/<path\b/g) || []).length,
  1,
  "settings icon must keep the original compound path intact"
);

const inlineScript = ui.match(/<script>([\s\S]*)<\/script>/);
assert.ok(inlineScript, "ui.html must contain its inline application script");
new vm.Script(inlineScript[1], { filename: "ui.html#script" });

console.log("Plugin structure and bundled UI are valid.");
