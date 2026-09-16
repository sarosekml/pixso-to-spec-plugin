import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginCode = await readFile(
  path.join(projectRoot, "src", "pixso-to-spec-plugin", "code.js"),
  "utf8"
);

function makeText(name, characters, children = []) {
  return { type: "TEXT", name, characters, children };
}

function makeFrame({ id, name, page, children = [], bytes = [1, 2, 3] }) {
  const calls = [];
  return {
    id,
    name,
    type: "FRAME",
    parent: page,
    children,
    exportCalls: calls,
    async exportAsync(settings) {
      calls.push(settings);
      return new Uint8Array(bytes);
    },
  };
}

async function loadPlugin({ selection = [], savedPreferences, fileKey = "file key" } = {}) {
  const messages = [];
  const listeners = {};
  const storageWrites = [];
  const page = { id: "0:1", name: "Page 1", type: "PAGE", selection };
  selection.forEach((node) => {
    if (!node.parent) node.parent = page;
  });

  const pixso = {
    currentPage: page,
    currentTheme: "LIGHT",
    fileKey,
    origin: "https://pixso.net/",
    root: { name: "Product screens" },
    ui: {
      postMessage(message) { messages.push(message); },
      onmessage: null,
    },
    showUI(html, options) {
      this.showUiCall = { html, options };
    },
    on(type, callback) { listeners[type] = callback; },
    notify() {},
    base64Encode(bytes) { return Buffer.from(bytes).toString("base64"); },
    clientStorage: {
      async getAsync() { return savedPreferences; },
      async setAsync(key, value) { storageWrites.push({ key, value }); },
    },
  };

  const context = vm.createContext({
    pixso,
    __html__: "<html></html>",
    Uint8Array,
    Buffer,
    Date,
    Promise,
    setTimeout,
    encodeURIComponent,
    console,
  });
  new vm.Script(pluginCode, { filename: "code.js" }).runInContext(context);
  await new Promise((resolve) => setImmediate(resolve));

  return { pixso, page, messages, listeners, storageWrites };
}

test("initializes the UI and enables export only for selected top-level frames", async () => {
  const page = { id: "0:1", type: "PAGE" };
  const frame = makeFrame({ id: "12:34", name: "Checkout", page });
  const nestedFrame = makeFrame({ id: "12:35", name: "Nested card", page: frame });
  const group = { id: "99:1", name: "Group", type: "GROUP", parent: page };
  const runtime = await loadPlugin({ selection: [frame, nestedFrame, group] });

  assert.equal(runtime.pixso.showUiCall.options.title, "Pixso to Spec");
  assert.equal(runtime.pixso.showUiCall.options.width, 350);
  assert.equal(runtime.pixso.showUiCall.options.height, 650);
  assert.equal(typeof runtime.listeners.selectionchange, "function");

  const selectionState = runtime.messages.find((message) => message.type === "selection-state");
  assert.deepEqual(
    { frameCount: selectionState.frameCount, selectionCount: selectionState.selectionCount, exportEnabled: selectionState.exportEnabled },
    { frameCount: 1, selectionCount: 3, exportEnabled: true }
  );
  assert.deepEqual(selectionState.frames.map((selected) => selected.id), ["12:34"]);
});

test("a nested frame alone does not enable or run export", async () => {
  const page = { id: "0:1", type: "PAGE" };
  const outerFrame = makeFrame({ id: "20:1", name: "Screen", page });
  const nestedFrame = makeFrame({ id: "20:2", name: "Card", page: outerFrame });
  const runtime = await loadPlugin({ selection: [nestedFrame] });

  const selectionState = runtime.messages.find((message) => message.type === "selection-state");
  assert.equal(selectionState.frameCount, 0);
  assert.equal(selectionState.exportEnabled, false);

  runtime.messages.length = 0;
  await runtime.pixso.ui.onmessage({ type: "request-export", format: "html" });
  assert.equal(runtime.messages.some((message) => message.type === "export-row"), false);
  assert.match(
    runtime.messages.find((message) => message.type === "export-error").message,
    /select at least one top-level frame/i
  );
});

test("Markdown export emits links and descriptions without rendering JPEGs", async () => {
  const page = { id: "0:1", type: "PAGE" };
  const frame = makeFrame({
    id: "12:34",
    name: "Checkout",
    page,
    children: [
      { type: "GROUP", name: "Content", children: [makeText("Description", "Pay with a saved card.")] },
    ],
  });
  const runtime = await loadPlugin({ selection: [frame] });
  runtime.messages.length = 0;

  await runtime.pixso.ui.onmessage({ type: "request-export", format: "md" });

  const row = runtime.messages.find((message) => message.type === "export-row").row;
  assert.equal(row.name, "Checkout");
  assert.equal(row.description, "Pay with a saved card.");
  assert.equal(row.imageBase64, "");
  assert.equal(frame.exportCalls.length, 0);
  assert.equal(
    row.url,
    "https://pixso.net/app/editor/file%20key?showQuickFrame=true&icon_type=1&page-id=0%3A1&item-id=12%3A34"
  );
});

test("export follows the validated frame order requested by the UI", async () => {
  const page = { id: "0:1", type: "PAGE" };
  const first = makeFrame({ id: "6:1", name: "First", page });
  const second = makeFrame({ id: "6:2", name: "Second", page });
  const third = makeFrame({ id: "6:3", name: "Third", page });
  const runtime = await loadPlugin({ selection: [first, second, third] });
  runtime.messages.length = 0;

  await runtime.pixso.ui.onmessage({
    type: "request-export",
    format: "md",
    frameIds: ["6:3", "unknown", "6:1", "6:3"],
  });

  const rows = runtime.messages
    .filter((message) => message.type === "export-row")
    .map((message) => message.row.id);
  assert.deepEqual(rows, ["6:3", "6:1", "6:2"]);
});

test("HTML embedded mode renders every selected frame as JPEG base64", async () => {
  const page = { id: "0:1", type: "PAGE" };
  const first = makeFrame({ id: "1:1", name: "First", page, bytes: [1, 2, 3] });
  const second = makeFrame({ id: "1:2", name: "Second", page, bytes: [4, 5, 6] });
  const runtime = await loadPlugin({ selection: [first, second] });
  runtime.messages.length = 0;

  await runtime.pixso.ui.onmessage({
    type: "request-export",
    format: "html",
    imageMode: "embedded",
  });

  const rows = runtime.messages.filter((message) => message.type === "export-row");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].row.imageBase64, "AQID");
  assert.equal(rows[1].row.imageBase64, "BAUG");
  assert.equal(first.exportCalls[0].format, "JPG");
  assert.equal(first.exportCalls[0].constraint.type, "SCALE");
  assert.equal(first.exportCalls[0].constraint.value, 1);
  const complete = runtime.messages.find((message) => message.type === "export-complete");
  assert.equal(complete.imageMode, "embedded");
});

test("HTML separate mode exports JPEG data for ZIP packaging", async () => {
  const page = { id: "0:1", type: "PAGE" };
  const frame = makeFrame({ id: "4:1", name: "Details", page, bytes: [7, 8, 9] });
  const runtime = await loadPlugin({ selection: [frame] });
  runtime.messages.length = 0;

  await runtime.pixso.ui.onmessage({
    type: "request-export",
    format: "html",
    imageMode: "separate",
  });

  const row = runtime.messages.find((message) => message.type === "export-row").row;
  const complete = runtime.messages.find((message) => message.type === "export-complete");
  assert.equal(row.imageBase64, "BwgJ");
  assert.equal(frame.exportCalls.length, 1);
  assert.equal(complete.imageMode, "separate");
});

test("HTML no-image mode does not render JPEGs", async () => {
  const page = { id: "0:1", type: "PAGE" };
  const frame = makeFrame({ id: "5:1", name: "No preview", page });
  const runtime = await loadPlugin({ selection: [frame] });
  runtime.messages.length = 0;

  await runtime.pixso.ui.onmessage({
    type: "request-export",
    format: "html",
    imageMode: "none",
  });

  const row = runtime.messages.find((message) => message.type === "export-row").row;
  const complete = runtime.messages.find((message) => message.type === "export-complete");
  assert.equal(row.imageBase64, "");
  assert.equal(frame.exportCalls.length, 0);
  assert.equal(complete.imageMode, "none");
});

test("an absent description layer produces an empty table cell", async () => {
  const page = { id: "0:1", type: "PAGE" };
  const frame = makeFrame({
    id: "2:1",
    name: "Empty state",
    page,
    children: [makeText("Title", "Nothing here")],
  });
  const runtime = await loadPlugin({ selection: [frame] });
  runtime.messages.length = 0;

  await runtime.pixso.ui.onmessage({ type: "request-export", format: "md" });

  assert.equal(runtime.messages.find((message) => message.type === "export-row").row.description, "");
});

test("preferences are normalized and persisted through Pixso storage", async () => {
  const runtime = await loadPlugin({
    savedPreferences: { format: "html", imageMode: "separate", theme: "dark" },
  });
  const initialization = runtime.messages.find((message) => message.type === "initialize");
  assert.equal(initialization.preferences.format, "html");
  assert.equal(initialization.preferences.imageMode, "separate");
  assert.equal(initialization.preferences.theme, "dark");

  await runtime.pixso.ui.onmessage({
    type: "save-preferences",
    format: "invalid",
    imageMode: "invalid",
    theme: "LIGHT",
  });
  assert.equal(runtime.storageWrites[0].value.format, "md");
  assert.equal(runtime.storageWrites[0].value.imageMode, "embedded");
  assert.equal(runtime.storageWrites[0].value.theme, "light");
});

test("export reports a clear error when Pixso has no file key", async () => {
  const page = { id: "0:1", type: "PAGE" };
  const frame = makeFrame({ id: "3:1", name: "Broken link", page });
  const runtime = await loadPlugin({ selection: [frame], fileKey: "" });
  runtime.messages.length = 0;

  await runtime.pixso.ui.onmessage({ type: "request-export", format: "md" });

  const error = runtime.messages.find((message) => message.type === "export-error");
  assert.match(error.message, /file key/i);
  assert.equal(runtime.messages.some((message) => message.type === "export-complete"), false);
});
