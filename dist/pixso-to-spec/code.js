/*
 * Pixso to Spec — Pixso sandbox runtime.
 *
 * The sandbox can read the Pixso document but cannot use browser APIs. The
 * iframe in ui.html owns file generation and download; this file owns frame
 * selection, Pixso links, description lookup, and JPEG export.
 */

var PLUGIN_NAME = "Pixso to Spec";
var PREFERENCES_KEY = "pixso-to-spec:preferences";
var DESCRIPTION_LAYER_NAME = "description";
var exportInProgress = false;

// Keep these calls adjacent. Pixso wires the sandbox/UI channel by scanning
// for the literal showUI and onmessage assignments.
pixso.showUI(__html__, {
  width: 350,
  height: 650,
  title: PLUGIN_NAME,
  themeColors: true,
  enableResize: false,
});
pixso.ui.onmessage = function (message) {
  return handleUiMessage(message);
};

function postMessage(message) {
  pixso.ui.postMessage(message);
}

function normalizeFormat(value) {
  return value === "html" ? "html" : "md";
}

function normalizeTheme(value) {
  var theme = String(value || "").toLowerCase();
  return theme.indexOf("light") !== -1 ? "light" : "dark";
}

function errorMessage(error) {
  if (error && typeof error.message === "string" && error.message) {
    return error.message;
  }
  return String(error || "Unknown error");
}

function getSelection() {
  try {
    var selection = pixso.currentPage && pixso.currentPage.selection;
    return Array.isArray(selection) ? selection : [];
  } catch (_) {
    return [];
  }
}

function getSelectedFrames() {
  return getSelection().filter(function (node) {
    return (
      node &&
      node.type === "FRAME" &&
      node.parent &&
      node.parent.type === "PAGE"
    );
  });
}

function getOwnerPage(node) {
  var current = node;
  var guard = 0;
  while (current && guard < 64) {
    if (current.type === "PAGE") return current;
    current = current.parent;
    guard += 1;
  }
  return pixso.currentPage || null;
}

function publishSelection() {
  var selection = getSelection();
  var frames = getSelectedFrames();
  postMessage({
    type: "selection-state",
    selectionCount: selection.length,
    frameCount: frames.length,
    exportEnabled: frames.length > 0 && !exportInProgress,
    frames: frames.map(function (frame) {
      return { id: frame.id, name: frame.name || "Untitled frame" };
    }),
  });
}

function encodeQueryValue(value) {
  return encodeURIComponent(String(value || ""));
}

function getPixsoOrigin() {
  var origin = "";
  try {
    origin = typeof pixso.origin === "string" ? pixso.origin : "";
  } catch (_) {}

  if (!/^https?:\/\//i.test(origin)) {
    origin = "https://pixso.net";
  }
  return origin.replace(/\/$/, "");
}

function buildFrameUrl(frame) {
  var fileKey = "";
  try {
    fileKey = typeof pixso.fileKey === "string" ? pixso.fileKey : "";
  } catch (_) {}

  if (!fileKey) {
    throw new Error("Pixso did not provide a file key for this document.");
  }

  var page = getOwnerPage(frame);
  var query = [
    "showQuickFrame=true",
    "icon_type=1",
    "page-id=" + encodeQueryValue(page && page.id),
    "item-id=" + encodeQueryValue(frame.id),
  ].join("&");

  return getPixsoOrigin() + "/app/editor/" + encodeURIComponent(fileKey) + "?" + query;
}

async function loadNode(node) {
  if (node && typeof node.loadAsync === "function") {
    await node.loadAsync();
  }
  return node;
}

async function findDescriptionText(frame) {
  var queue = [];
  await loadNode(frame);
  if (frame && Array.isArray(frame.children)) {
    queue = frame.children.slice();
  }

  while (queue.length > 0) {
    var node = queue.shift();
    if (!node) continue;
    await loadNode(node);

    if (
      node.type === "TEXT" &&
      String(node.name || "").trim().toLowerCase() === DESCRIPTION_LAYER_NAME
    ) {
      return typeof node.characters === "string" ? node.characters : "";
    }

    if (Array.isArray(node.children) && node.children.length > 0) {
      queue = queue.concat(node.children);
    }
  }

  return "";
}

function base64EncodeRange(bytes, start, end) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var result = "";
  for (var index = start; index < end; index += 3) {
    var first = bytes[index];
    var second = index + 1 < end ? bytes[index + 1] : 0;
    var third = index + 2 < end ? bytes[index + 2] : 0;
    result += chars[first >> 2];
    result += chars[((first & 3) << 4) | (second >> 4)];
    result += index + 1 < end ? chars[((second & 15) << 2) | (third >> 6)] : "=";
    result += index + 2 < end ? chars[third & 63] : "=";
  }
  return result;
}

async function encodeBytes(bytes) {
  if (typeof pixso.base64Encode === "function") {
    return pixso.base64Encode(bytes);
  }

  var array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  var chunkSize = 49152;
  var encoded = "";
  for (var offset = 0; offset < array.length; offset += chunkSize) {
    encoded += base64EncodeRange(array, offset, Math.min(offset + chunkSize, array.length));
    await new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }
  return encoded;
}

async function exportFrameJpeg(frame) {
  if (!frame || typeof frame.exportAsync !== "function") {
    throw new Error("Frame does not support image export.");
  }

  var bytes = await frame.exportAsync({
    format: "JPG",
    constraint: { type: "SCALE", value: 1 },
  });

  return "data:image/jpeg;base64," + (await encodeBytes(bytes));
}

function getDocumentName() {
  try {
    if (pixso.root && typeof pixso.root.name === "string" && pixso.root.name) {
      return pixso.root.name;
    }
  } catch (_) {}
  return "Pixso document";
}

async function savePreferences(message) {
  var preferences = {
    format: normalizeFormat(message && message.format),
    theme: normalizeTheme(message && message.theme),
  };
  await pixso.clientStorage.setAsync(PREFERENCES_KEY, preferences);
}

async function loadPreferences() {
  var saved = null;
  try {
    saved = await pixso.clientStorage.getAsync(PREFERENCES_KEY);
  } catch (_) {}

  var currentTheme = "dark";
  try {
    currentTheme = normalizeTheme(pixso.currentTheme);
  } catch (_) {}

  return {
    format: normalizeFormat(saved && saved.format),
    theme: saved && saved.theme ? normalizeTheme(saved.theme) : currentTheme,
  };
}

async function runExport(formatValue) {
  if (exportInProgress) return;

  var format = normalizeFormat(formatValue);
  var frames = getSelectedFrames().slice();
  if (frames.length === 0) {
    postMessage({
      type: "export-error",
      message: "Select at least one top-level frame in Pixso before exporting.",
    });
    publishSelection();
    return;
  }

  exportInProgress = true;
  publishSelection();
  postMessage({ type: "export-start", format: format, total: frames.length });

  var warnings = [];
  try {
    for (var index = 0; index < frames.length; index += 1) {
      var frame = frames[index];
      var row = {
        id: frame.id,
        name: frame.name || "Untitled frame",
        url: buildFrameUrl(frame),
        description: await findDescriptionText(frame),
        imageDataUri: "",
        imageError: "",
      };

      if (format === "html") {
        try {
          row.imageDataUri = await exportFrameJpeg(frame);
        } catch (imageError) {
          row.imageError = errorMessage(imageError);
          warnings.push(row.name + ": " + row.imageError);
        }
      }

      postMessage({
        type: "export-row",
        row: row,
        current: index + 1,
        total: frames.length,
      });
    }

    postMessage({
      type: "export-complete",
      format: format,
      total: frames.length,
      documentName: getDocumentName(),
      exportedAt: new Date().toISOString(),
      warnings: warnings,
    });

    if (typeof pixso.notify === "function") {
      pixso.notify(
        warnings.length > 0
          ? "Spec exported with " + warnings.length + " image warning(s)."
          : "Spec exported for " + frames.length + " frame(s).",
        { icon: warnings.length > 0 ? "WARN" : "SUCCESS" }
      );
    }
  } catch (error) {
    postMessage({ type: "export-error", message: errorMessage(error) });
    if (typeof pixso.notify === "function") {
      pixso.notify("Export failed: " + errorMessage(error), {
        error: true,
        icon: "ERROR",
      });
    }
  } finally {
    exportInProgress = false;
    publishSelection();
  }
}

async function handleUiMessage(message) {
  if (!message || typeof message.type !== "string") return;

  if (message.type === "request-export") {
    await runExport(message.format);
    return;
  }

  if (message.type === "save-preferences") {
    await savePreferences(message);
    return;
  }

  if (message.type === "request-selection") {
    publishSelection();
  }
}

async function initializePlugin() {
  postMessage({
    type: "initialize",
    preferences: await loadPreferences(),
    pluginVersion: "1.0.0",
  });
  publishSelection();
}

if (typeof pixso.on === "function") {
  pixso.on("selectionchange", publishSelection);
  pixso.on("currentpagechange", publishSelection);
}

initializePlugin().catch(function (error) {
  postMessage({ type: "export-error", message: errorMessage(error) });
});
