import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { settings } from "./fixtures/studio-ui.mjs";

const require = createRequire(import.meta.url);
const sdk = 'export class Extension { static method(spec) { return spec; } } export function extension(meta) { return target => target; } export function settings(factory) { return { factory }; }';
const moduleUrl = (code) => "data:text/javascript;base64," + Buffer.from(code).toString("base64");
async function loadBundle(file) {
  let code = await readFile(new URL("../dist/" + file, import.meta.url), "utf8");
  assert.doesNotMatch(code, /powershell\.exe|WINDOWS_SERIAL_SCRIPT|EncodedCommand/);
  // Mirror the host's shared-import replacement, then load from a data URL with
  // no filesystem base. Native serial must not resolve packages relative to it.
  code = code.replace(/from (["'])([^"']+)\1/g, (_, quote, name) => {
    if (name === "@avg-studio/sdk") return `from "${moduleUrl(sdk)}"`;
    if (name === "@avg-studio/studio-ui") return `from "${new URL("./fixtures/studio-ui.mjs", import.meta.url).href}"`;
    assert.ok(["react", "react-dom", "react/jsx-runtime"].includes(name), "Unexpected external: " + name);
    return `from "${pathToFileURL(require.resolve(name)).href}"`;
  });
  return import(moduleUrl(code));
}

test("built runtime loads without a file base and enumerates through the embedded driver", async (t) => {
  const { SerialDevicePickerExtension } = await loadBundle("index.mjs");
  const abort = new AbortController();
  const nativeCalls = [];
  const picker = new SerialDevicePickerExtension();
  picker.context = {
    flow: { signal: abort.signal }, variables: { get() {} },
    settings: { get(name) { return ({ transport: "serial", serialBackend: "windows", baudRate: 115200 })[name.replace(/^osr6\./, "")]; } },
    native: { node: { require(name) {
      assert.match(name, /^node:/); nativeCalls.push(name); return require(name);
    } } },
  };
  const { props } = picker.render();
  assert.equal(props.initialBackend, "native");
  assert.equal(nativeCalls.length, 0, "import/render must not initialize native code");
  const api = props.getOptions("native").api;
  try {
    const ports = await api.getPorts();
    assert.ok(Array.isArray(ports));
    t.diagnostic("Built bundle system ports: " + ports.map((port) => port.displayName).join(", "));
  } finally { await api.dispose(); abort.abort(); }
});

test("built editor loads without native access and shows migrated settings", async () => {
  const { settingsPage } = await loadBundle("studio.js");
  settings.set("osr6.transport", "serial"); settings.set("osr6.serialBackend", "windows");
  try {
    const html = renderToStaticMarkup(React.createElement(settingsPage));
    assert.match(html, /桌面原生串口/); assert.match(html, /50% → 60% → 50%/);
  } finally { settings.clear(); }
});
