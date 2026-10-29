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
  const { default: Osr6Extension } = await loadBundle("index.mjs");
  const abort = new AbortController();
  const nativeCalls = [];
  const vars = new Map();
  const ctx = {
    flow: { signal: abort.signal },
    variables: { get: (name) => vars.get(name), set: (name, value) => { vars.set(name, value); } },
    settings: { get(name) { return ({ transport: "serial", serialBackend: "windows", baudRate: 115200 })[name.replace(/^osr6\./, "")]; } },
    native: { node: { require(name) {
      assert.match(name, /^node:/); nativeCalls.push(name); return require(name);
    } } },
  };
  // 面板改成引擎托管 UI 后，枚举由 scanSerialPorts 完成：它把结果写进 OSR6串口1..5。
  const summary = await Osr6Extension.scanSerialPorts.run(ctx, {});
  assert.match(summary, /找到|没有找到/);
  assert.equal(vars.size >= 5, true, "五个槽位变量都应写入");
  assert.ok(nativeCalls.includes("node:process"), "枚举必须走内嵌驱动");
  const labels = [1, 2, 3, 4, 5].map((slot) => vars.get("OSR6串口" + slot));
  t.diagnostic("Built bundle system ports: " + labels.filter((label) => label !== "—").join(", "));
  abort.abort();
});

test("built editor loads without native access and shows migrated settings", async () => {
  const { settingsPage } = await loadBundle("studio.js");
  settings.set("osr6.transport", "serial");
  // 访问方式自动判定：宿主有 Node 才显示桌面原生串口。
  const hadRequire = Object.prototype.hasOwnProperty.call(globalThis, "require");
  const previousRequire = globalThis.require;
  globalThis.require = () => { throw new Error("render must not load native code"); };
  try {
    const html = renderToStaticMarkup(React.createElement(settingsPage));
    assert.match(html, /刷新系统串口/);
    assert.match(html, /50% → 60% → 50%/);
  } finally {
    if (hadRequire) globalThis.require = previousRequire;
    else delete globalThis.require;
    settings.clear();
  }
});
