import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = await readFile(
  path.join(projectRoot, "src", "pixso-to-spec-plugin", "ui.html"),
  "utf8"
);
const inlineScript = ui.match(/<script>([\s\S]*)<\/script>/)?.[1];
assert.ok(inlineScript, "ui.html must contain an inline script");

function createClassList() {
  const values = new Set();
  return {
    add(value) { values.add(value); },
    remove(value) { values.delete(value); },
    toggle(value, force) {
      if (force === undefined ? !values.has(value) : force) values.add(value);
      else values.delete(value);
    },
  };
}

function createElement(id = "") {
  return {
    id,
    className: "",
    classList: createClassList(),
    style: {},
    textContent: "",
    title: "",
    disabled: false,
    children: [],
    addEventListener(type, callback) { this[`on${type}`] = callback; },
    appendChild(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    remove() {},
    click() {},
  };
}

function loadUi() {
  const elements = new Map();
  [
    "main-screen", "settings-screen", "export-button", "selection-card",
    "selection-title", "selection-help", "frame-list", "progress",
    "progress-label", "progress-value", "progress-bar", "status",
    "theme-toggle", "settings-open", "settings-back", "plugin-version",
  ].forEach((id) => elements.set(id, createElement(id)));

  const formatInputs = [
    { value: "md", checked: true, addEventListener() {} },
    { value: "html", checked: false, addEventListener() {} },
  ];
  const imageInputs = [
    { value: "embedded", checked: true, addEventListener() {} },
    { value: "separate", checked: false, addEventListener() {} },
    { value: "none", checked: false, addEventListener() {} },
  ];
  const downloads = [];
  let pendingBlob = null;

  const document = {
    documentElement: { setAttribute() {} },
    body: { appendChild() {} },
    getElementById(id) { return elements.get(id); },
    querySelectorAll(selector) {
      return selector.includes("image-mode") ? imageInputs : formatInputs;
    },
    querySelector(selector) {
      const inputs = selector.includes("image-mode") ? imageInputs : formatInputs;
      const value = selector.match(/value="([^"]+)"/)?.[1];
      if (value) return inputs.find((input) => input.value === value) || null;
      return inputs.find((input) => input.checked) || null;
    },
    createElement(tag) {
      if (tag !== "a") return createElement();
      const anchor = createElement();
      anchor.click = function () {
        downloads.push({ filename: anchor.download, blob: pendingBlob });
      };
      return anchor;
    },
  };

  const window = {
    parent: { postMessage() {} },
    setTimeout(callback) { callback(); },
    onmessage: null,
  };
  const url = {
    createObjectURL(blob) {
      pendingBlob = blob;
      return "blob:test";
    },
    revokeObjectURL() {},
  };

  const context = vm.createContext({
    document,
    window,
    URL: url,
    Blob,
    TextEncoder,
    Uint8Array,
    Uint32Array,
    Date,
    Array,
    String,
    atob,
  });
  new vm.Script(inlineScript, { filename: "ui.html#script" }).runInContext(context);
  return { window, downloads };
}

function messageUi(runtime, message) {
  runtime.window.onmessage({ data: { pluginMessage: message } });
}

test("separate JPEG mode downloads one ZIP with HTML and image entries", async () => {
  const runtime = loadUi();
  messageUi(runtime, {
    type: "initialize",
    preferences: { format: "html", imageMode: "separate", theme: "dark" },
    pluginVersion: "1.1.0",
  });
  messageUi(runtime, { type: "export-start", format: "html", imageMode: "separate", total: 1 });
  messageUi(runtime, {
    type: "export-row",
    current: 1,
    total: 1,
    row: {
      id: "1:1",
      name: "Frame One",
      url: "https://pixso.net/app/editor/file?item-id=1%3A1",
      description: "Description",
      imageBase64: "AQID",
      imageError: "",
    },
  });
  messageUi(runtime, {
    type: "export-complete",
    format: "html",
    imageMode: "separate",
    documentName: "Demo",
    warnings: [],
  });

  assert.equal(runtime.downloads.length, 1);
  assert.equal(runtime.downloads[0].filename, "demo-spec.zip");
  assert.equal(runtime.downloads[0].blob.type, "application/zip");
  const bytes = new Uint8Array(await runtime.downloads[0].blob.arrayBuffer());
  assert.deepEqual(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04]);
  const binaryText = Buffer.from(bytes).toString("latin1");
  assert.match(binaryText, /index\.html/);
  assert.match(binaryText, /images\/001-frame-one\.jpg/);
  assert.equal(binaryText.includes("data:image/jpeg;base64"), false);
  assert.equal(Buffer.from(bytes).includes(Buffer.from([1, 2, 3])), true);
});

test("no-image HTML mode downloads HTML without image markup", async () => {
  const runtime = loadUi();
  messageUi(runtime, { type: "export-start", format: "html", imageMode: "none", total: 1 });
  messageUi(runtime, {
    type: "export-row",
    current: 1,
    total: 1,
    row: {
      id: "2:1",
      name: "Text only",
      url: "https://pixso.net/app/editor/file?item-id=2%3A1",
      description: "No preview",
      imageBase64: "",
      imageError: "",
    },
  });
  messageUi(runtime, {
    type: "export-complete",
    format: "html",
    imageMode: "none",
    documentName: "Links",
    warnings: [],
  });

  assert.equal(runtime.downloads.length, 1);
  assert.equal(runtime.downloads[0].filename, "links-spec.html");
  const html = await runtime.downloads[0].blob.text();
  assert.match(html, /<th>Pixso link<\/th>/);
  assert.doesNotMatch(html, /<img\b/);
  assert.doesNotMatch(html, /data:image\/jpeg;base64/);
});
