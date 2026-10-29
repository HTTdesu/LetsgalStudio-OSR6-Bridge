import assert from "node:assert/strict";
import { test, after, afterEach } from "node:test";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import ts from "typescript";
import { createRequire } from "node:module";
import { createSerialportBundle } from "../scripts/serialport-bundle.mjs";
import { fakeNativeAddon } from "./fixtures/native-addon.mjs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { settings as studioSettings } from "./fixtures/studio-ui.mjs";

// 用已声明的 TypeScript 依赖编译到临时目录；不需要设备或新增测试框架。
const root = fileURLToPath(new URL("../", import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), "osr6-connections-"));
const require = createRequire(import.meta.url);
after(() => rm(temp, { recursive: true, force: true }));
await writeFile(path.join(temp, "serialport-bundle.mjs"), await createSerialportBundle());
await writeFile(path.join(temp, "mock-sdk.mjs"), `
export class Extension { static method(spec) { return spec; } }
export function extension(meta) { return target => { target.meta = meta; return target; }; }
export function settings(factory) { return { factory }; }
`);
for (const file of await readdir(path.join(root, "src"))) {
  if (!/\.tsx?$/.test(file) || file.endsWith(".d.ts")) continue;
  const source = await readFile(path.join(root, "src", file), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText.replace(/from (["'])([^"']+)\1/g, (match, quote, name) => {
    if (name === "@avg-studio/sdk") return 'from "./mock-sdk.mjs"';
    if (name === "virtual:osr6-serialport") return 'from "./serialport-bundle.mjs"';
    if (name === "@avg-studio/studio-ui") return `from "${pathToFileURL(path.join(root, "tests/fixtures/studio-ui.mjs")).href}"`;
    if (name.startsWith("./")) return `from "${name}.mjs"`;
    if (name === "react" || name === "react/jsx-runtime") {
      const target = name === "react" ? "react/index.js" : "react/jsx-runtime.js";
      return `from "${pathToFileURL(path.join(root, "node_modules", target)).href}"`;
    }
    return match;
  });
  await writeFile(path.join(temp, file.replace(/\.tsx?$/, ".mjs")), compiled);
}
const load = (name) => import(pathToFileURL(path.join(temp, name + ".mjs")).href);
const transportModule = await load("transport");
const { createSerialTransport, requestSerialDevice, listSerialDevices } = transportModule;
const { Osr6Engine } = await load("engine");
const { runtimeForSignal } = await load("runtime-state");
const { probeSerialDevice, testSerialDevice } = await load("serial-probe");
const { probeUdpDevice } = await load("udp-probe");
const { encodeCarrierWav } = await load("carrier");
const { NativeSerialApi } = await load("native-serial");
const { loadSerialPort, selectSerialportBinary } = await load("serialport-loader");
const { createStudioSerialApi } = await load("studio-serial");
const { settingsPage: StudioSettingsPage } = await load("studio");
const { default: Extension } = await load("index");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const resources = [];
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else delete globalThis.navigator;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else delete globalThis.window;
});
const turn = () => new Promise((resolve) => setImmediate(resolve));
const waitFor = async (predicate) => {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("condition did not become true");
};
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function fakePort(info = { usbVendorId: 0x1a86, usbProductId: 0x7523 }, hooks = {}) {
  const target = new EventTarget();
  return Object.assign(target, {
    connected: true, writable: null, readable: null, opened: false,
    opens: 0, closes: 0, writes: [], getInfo: () => info,
    async open(options) {
      if (this.opened) throw new Error("port already open");
      this.opens++;
      await hooks.open?.(options);
      this.opened = true;
      this.readable = new ReadableStream({ start: (controller) => { this.readerController = controller; } });
      this.writable = new WritableStream({ write: async (bytes) => {
        const text = new TextDecoder().decode(bytes);
        this.writes.push(text);
        await hooks.write?.(text, this);
      } });
    },
    async close() {
      assert.equal(this.writable?.locked, false, "writer must be released before port.close");
      assert.equal(this.readable?.locked, false, "reader must be released before port.close");
      this.opened = false; this.closes++;
    },
  });
}
function serialApi(ports, request = () => ports[0]) {
  const api = { requests: 0, requestOptions: undefined, async getPorts() { return ports; },
    requestPort(options) { this.requests++; this.requestOptions = options; return Promise.resolve().then(request); } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serial: api } });
  return api;
}
function settings(overrides = {}) {
  return { transport: "serial", serialKind: "auto", udpHost: "192.168.1.1", udpPort: 8000,
    baudRate: 115200,
    updateHz: 30, smoothing: 0, idleStopMs: 0, axes: [], ...overrides };
}
function engine() {
  const value = new Osr6Engine(); resources.push(() => value.disconnect()); return value;
}
function context(overrides = {}) {
  const abort = new AbortController();
  const values = new Map();
  const config = settings(overrides);
  const ctx = { flow: { signal: abort.signal }, variables: { get: (key) => values.get(key), set: (key, value) => values.set(key, value) },
    settings: { get: (key) => config[key.replace(/^osr6\./, "")] },
    native: { node: { require() { assert.fail("serial must not load Node"); } } },
    ui: { calls: [], async show(...args) { this.calls.push(args); }, async hide() {} },
    visualUI: { calls: [], async open(...args) { this.calls.push(args); return { name: args[0], get: () => null }; } } };
  resources.push(async () => { abort.abort(); await runtimeForSignal(abort.signal).engine.disconnect(); });
  return { ctx, abort, values, config };
}

test("USB connects in a browser without loading Node and releases locks on reconnect", async () => {
  const port = fakePort(); const api = serialApi([port]); const value = engine();
  const dependencies = { loadDgram: () => assert.fail("Node must not be touched") };
  await value.connect(settings(), dependencies);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(port.writes, [], "connecting must not start motion");
  value.setAxisExact("L0", 0.25); await turn();
  assert.ok(port.writes.includes("L02500\n"));
  await value.connect(settings(), dependencies);
  assert.equal(port.opens, 2); assert.equal(port.closes, 1); assert.equal(api.requests, 0);
});

test("automatic connection never prompts and refuses ambiguous or changed ports", async () => {
  const one = fakePort(); const two = fakePort(); const ports = [one, two]; const api = serialApi(ports);
  await assert.rejects(createSerialTransport({ baudRate: 115200, portIndex: 0 }), /多个/);
  await assert.rejects(createSerialTransport({ baudRate: 115200, selectedPort: fakePort() }), /原设备/);
  ports.length = 0;
  await assert.rejects(createSerialTransport({ baudRate: 115200 }), /选择串口设备/);
  assert.equal(api.requests, 0);
});

test("explicit selection overrides list order", async () => {
  const unrelated = fakePort({ usbVendorId: 1 }); const wanted = fakePort();
  const ports = [unrelated, wanted]; serialApi(ports);
  // 不再按 VID/PID 过滤：两个端口都列出来，由用户明确选择。
  const found = await listSerialDevices({ baudRate: 115200 });
  assert.equal(found.length, 2);
  assert.equal(found[0].index, 0);
  ports.reverse();
  const channel = await createSerialTransport({ baudRate: 115200, selectedPort: wanted });
  resources.push(() => channel.close());
  assert.equal(wanted.opens, 1); assert.equal(unrelated.opens, 0);
});

test("SPP requests happen synchronously on click and ignore USB filters", async () => {
  const port = fakePort({ bluetoothServiceClassId: "00001101-0000-1000-8000-00805f9b34fb" });
  const api = serialApi([port]);
  const result = requestSerialDevice({ baudRate: 115200, kind: "bluetooth", vendorId: 999, productId: 888 });
  assert.equal(api.requests, 1, "request must be called before awaiting anything");
  assert.deepEqual(api.requestOptions, { filters: [{ bluetoothServiceClassId: 0x1101 }] });
  await result;
  const value = engine();
  await value.connect(settings({ serialKind: "bluetooth" }));
  assert.match(value.endpoint, /蓝牙串口/);
});

test("USB request asks for any port and keeps cancellation as cancellation", async () => {
  const port = fakePort({ usbVendorId: 1, usbProductId: 9 });
  const api = serialApi([port]);
  await requestSerialDevice({ baudRate: 115200 });
  // 不再按 VID/PID 预筛：请求不带 filters，由用户在选择框里挑。
  assert.equal(api.requestOptions, undefined);
  serialApi([], () => { throw new DOMException("cancelled", "NotFoundError"); });
  await assert.rejects(requestSerialDevice({ baudRate: 115200 }), { name: "NotFoundError" });
});

test("write failure updates connection status and releases the physical port", async () => {
  const port = fakePort(undefined, { write: () => { throw new Error("unplugged"); } });
  serialApi([port]); const value = engine(); await value.connect(settings());
  value.setAxisExact("L0", 0.1);
  await waitFor(() => !value.connected && port.closes === 1);
  assert.match(value.snapshot().lastError, /unplugged/);
});

test("disconnect event stops the session and cleans up", async () => {
  const port = fakePort(); serialApi([port]); const value = engine(); await value.connect(settings());
  port.connected = false; port.dispatchEvent(new Event("disconnect"));
  await waitFor(() => port.closes === 1);
  assert.equal(value.connected, false); assert.match(value.errorText, /断开/);
});

test("urgent stop drops queued positions; slow writes coalesce each axis", async () => {
  const blocked = deferred(); const started = deferred();
  const port = fakePort(undefined, { write: async (_, port) => { if (port.writes.length === 1) { started.resolve(); await blocked.promise; } } });
  serialApi([port]); const channel = await createSerialTransport({ baudRate: 115200 });
  resources.push(() => channel.close());
  channel.send("L01000\n"); await started.promise;
  channel.send("L02000\n"); channel.send("R03000\n"); channel.send("L04000\n");
  channel.send("DSTOP\n", true); blocked.resolve(); await turn();
  await channel.close();
  assert.deepEqual(port.writes, ["L01000\n", "DSTOP\n"]);
});

test("a pending open is cancelled on preview exit and cannot reconnect later", async () => {
  const opening = deferred(); const started = deferred();
  const port = fakePort(undefined, { open: async () => { started.resolve(); await opening.promise; } });
  serialApi([port]); const value = engine();
  const connecting = value.connect(settings());
  const rejection = assert.rejects(connecting, /取消/);
  await started.promise; const closing = value.disconnect(); opening.resolve();
  await Promise.all([rejection, closing]);
  assert.equal(value.connected, false); assert.equal(port.closes, 1);
});

test("slow serial writes retain the latest value of every axis", async () => {
  const blocked = deferred(); const started = deferred();
  const port = fakePort(undefined, { write: async (_, port) => {
    if (port.writes.length === 1) { started.resolve(); await blocked.promise; }
  } });
  serialApi([port]); const channel = await createSerialTransport({ baudRate: 115200 });
  resources.push(() => channel.close());
  channel.send("L01000\n"); await started.promise;
  channel.send("L02000\n"); channel.send("R03000\n"); channel.send("L04000\n");
  channel.send("D0\n"); blocked.resolve(); await channel.close();
  assert.deepEqual(port.writes, ["L01000\n", "D0\n", "L04000 R03000\n"]);
});

test("a second preview cannot steal or close an occupied serial port", async () => {
  const port = fakePort(); serialApi([port]); const owner = engine(); const other = engine();
  await owner.connect(settings());
  await assert.rejects(other.connect(settings()), /使用中/);
  assert.equal(owner.connected, true); assert.equal(port.closes, 0);
  await other.disconnect(); assert.equal(port.closes, 0);
  await owner.disconnect(); await other.connect(settings());
  assert.equal(port.opens, 2);
});

test("closing a stalled write has a finite timeout and still releases the writer", async () => {
  const started = deferred();
  const port = fakePort(undefined, { write: () => { started.resolve(); return new Promise(() => {}); } });
  serialApi([port]); const channel = await createSerialTransport({ baudRate: 115200 });
  resources.push(() => channel.close());
  channel.send("L01000\n"); await started.promise;
  await channel.close();
  assert.equal(port.writable.locked, false); assert.equal(port.closes, 1);
});

test("concurrent connection requests serialize and do not open the same port twice", async () => {
  const port = fakePort(); serialApi([port]); const value = engine();
  const one = value.connect(settings()); const two = value.connect(settings());
  const result = await Promise.allSettled([one, two]);
  assert.equal(result[0].status, "rejected"); assert.equal(result[1].status, "fulfilled");
  assert.equal(port.opens, 1);
});

test("editor identity probe releases reader and writer on response, timeout and cancellation", async () => {
  const port = fakePort(undefined, { write: (text, port) => {
    if (text === "D0\n") port.readerController.enqueue(new TextEncoder().encode("OSR test\n"));
  } });
  serialApi([port]);
  assert.deepEqual(await probeSerialDevice({ baudRate: 115200, selectedPort: port }), { ok: true, detail: "OSR test" });
  assert.equal(port.closes, 1);
  const silent = fakePort(); serialApi([silent]);
  assert.deepEqual(await probeSerialDevice({ baudRate: 115200, selectedPort: silent }, undefined, 15), { ok: true, detail: "connected-no-reply" });
  const abort = new AbortController();
  const probing = probeSerialDevice({ baudRate: 115200, selectedPort: silent }, abort.signal);
  await waitFor(() => silent.opened); abort.abort();
  await assert.rejects(probing, /取消/); assert.equal(silent.closes, 2);
});

test("runtime state and old preview cancellation cannot affect another engine", async () => {
  const a = new AbortController(); const b = new AbortController();
  const one = runtimeForSignal(a.signal); const two = runtimeForSignal(b.signal);
  resources.push(async () => { a.abort(); b.abort(); await Promise.all([one.engine.disconnect(), two.engine.disconnect()]); });
  assert.notEqual(one, two); assert.equal(runtimeForSignal(a.signal), one);
  one.playbackSpeed = 2; one.strengthRanges.set("L0", { min: 0.2, max: 0.5 });
  assert.equal(two.playbackSpeed, 1); assert.equal(two.strengthRanges.size, 0);
  const port = fakePort(); serialApi([port]); await two.engine.connect(settings()); a.abort();
  assert.equal(two.engine.connected, true);
});

test("runtime entry starts serial without Node; player picker preserves compatibility variables", async () => {
  const port = fakePort(); const api = serialApi([port]); const { ctx, values, abort } = context();
  await Extension.onRegister(ctx);
  await waitFor(() => runtimeForSignal(abort.signal).engine.connected);
  assert.equal(api.requests, 0);
  // 面板改成引擎托管 UI：扫描写入槽位变量，再按槽位连接。
  await Extension.scanSerialPorts.run(ctx, {});
  assert.ok(String(values.get("OSR6串口1")).length > 0);
  await Extension.pickSerialPort.run(ctx, { slot: 1 });
  assert.equal(values.get("OSR6连接方式"), "serial");
  assert.match(String(values.get("OSR6串口状态")), /已连接/);
});

test("first-time runtime connection opens the modal picker without requesting permissions", async () => {
  const api = serialApi([]); const { ctx } = context({ autoConnect: false });
  await Extension.connect.run(ctx);
  assert.equal(api.requests, 0);
  assert.equal(ctx.visualUI.calls[0][0], "@com.httdesu.osr6-bridge/osr6-settings");
  assert.equal(ctx.visualUI.calls[0][1].modal, true);
});

test("unavailable and insecure environments explain what is missing", async () => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  await assert.rejects(createSerialTransport({ baudRate: 115200 }), /Web Serial/);
  const value = engine();
  await assert.rejects(value.connect(settings({ transport: "udp" }), { loadDgram() { throw new Error("no node"); } }), /网页版/);
  Object.defineProperty(globalThis, "window", { configurable: true, value: { isSecureContext: false } });
  await assert.rejects(createSerialTransport({ baudRate: 115200 }), /HTTPS/);
});

const builtinNames = ["process", "buffer", "fs", "os", "path", "crypto", "zlib", "stream", "events", "util", "tty", "child_process"];
function nativeBridge(rows) {
  const addon = fakeNativeAddon(rows);
  let loads = 0;
  const fakeProcess = {
    ...process,
    platform: "win32", arch: "x64",
    dlopen(module) { loads++; module.exports = addon.binding; },
  };
  const host = { require(name) {
    assert.ok(name.startsWith("node:"), "load only fixed Node built-ins");
    if (name === "node:process") return fakeProcess;
    if (name === "node:child_process") return { spawn() { assert.fail("Windows serial must not spawn any process"); } };
    return require(name);
  } };
  const modules = Object.fromEntries(builtinNames.map((key) => [key, host.require("node:" + key)]));
  const api = new NativeSerialApi(() => loadSerialPort(modules));
  resources.push(() => api.dispose());
  return { ...addon, api, host, modules, get loads() { return loads; } };
}

test("native serial needs no browser picker and never auto-selects a port", async () => {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  const bridge = nativeBridge();
  await assert.rejects(createSerialTransport({ api: bridge.api, baudRate: 115200 }), /系统串口/);
  assert.equal(bridge.loads, 0, "auto connection does not initialize the driver");
  const ports = await bridge.api.getPorts();
  const again = await bridge.api.getPorts();
  assert.equal(ports[0], again[0]);
  assert.equal(bridge.loads, 1, "driver constructor reused across enumerations");
  const result = await probeSerialDevice({ api: bridge.api, selectedPort: ports[0], baudRate: 115200 });
  assert.deepEqual(result, { ok: true, detail: "Native OSR" });
  assert.equal(bridge.requests.filter((request) => request.action === "close").length, 1);
});

test("native device disconnection updates status and replaced port identities cannot be reused", async () => {
  const bridge = nativeBridge(); const [port] = await bridge.api.getPorts(); const value = engine();
  await value.connect(settings({ serialBackend: "native" }), { serialApi: bridge.api, selectedPort: port });
  await turn(); bridge.disconnect();
  await waitFor(() => !value.connected);
  assert.match(value.errorText, /disconnected/);
  const other = nativeBridge(); const [oldPort] = await other.api.getPorts();
  other.rows[0].pnpId = "DIFFERENT DEVICE";
  const [newPort] = await other.api.getPorts();
  assert.notEqual(oldPort, newPort); assert.equal(oldPort.connected, false);
  await assert.rejects(createSerialTransport({ api: other.api, selectedPort: oldPort, baudRate: 115200 }));
});

test("native backend persists player choice through the runtime SDK built-in loader", async () => {
  const bridge = nativeBridge(); const { ctx, values } = context({ autoConnect: false });
  ctx.native.node.require = bridge.host.require;
  await Extension.scanSerialPorts.run(ctx, {});
  await Extension.pickSerialPort.run(ctx, { slot: 1 });
  assert.match(String(values.get("OSR6串口1")), /COM3/);
  assert.match(String(values.get("OSR6串口状态")), /已连接/);
});

test("legacy windows settings normalize to native", async () => {
  assert.equal(transportModule.serialBackend("windows"), "native");
  assert.equal(transportModule.serialBackend("web"), "web");
  assert.equal(transportModule.serialBackend(undefined), "web");
});

test("embedded binaries cover desktop architectures and reject Android explicitly", () => {
  for (const arch of ["x64", "ia32", "arm64"]) assert.equal(selectSerialportBinary("win32", arch, undefined, "8").platform, "win32");
  for (const arch of ["x64", "arm64"]) assert.equal(selectSerialportBinary("darwin", arch).platform, "darwin");
  for (const arch of ["x64", "arm64", "arm"]) {
    for (const libc of ["glibc", "musl"]) assert.equal(selectSerialportBinary("linux", arch, libc, arch === "arm" ? "7" : "8").libc, libc);
  }
  assert.throws(() => selectSerialportBinary("android", "arm64"), /android\/arm64/);
});

test("embedded native driver enumerates actual system ports without opening hardware", async (t) => {
  const modules = Object.fromEntries(builtinNames.map((key) => [key, require("node:" + key)]));
  const SerialPort = loadSerialPort(modules);
  const api = new NativeSerialApi(() => SerialPort); resources.push(() => api.dispose());
  const ports = await api.getPorts();
  assert.ok(Array.isArray(ports));
  t.diagnostic("System ports: " + ports.map((port) => port.displayName).join(", "));
});

test("the native editor view renders a real port selector and refresh action", () => {
  studioSettings.clear();
  studioSettings.set("osr6.transport", "serial");
  // 访问方式现在自动判定：宿主有 Node 就用系统串口，不再读 osr6.serialBackend。
  const hadRequire = Object.prototype.hasOwnProperty.call(globalThis, "require");
  const previousRequire = globalThis.require;
  globalThis.require = () => { throw new Error("render must not load native code"); };
  try {
    const html = renderToStaticMarkup(React.createElement(StudioSettingsPage));
    assert.match(html, /<select[^>]*aria-label="串口"/);
    assert.match(html, /请选择串口/);
    assert.match(html, /刷新系统串口/);
    assert.match(html, /波特率/);
    // VID/PID 已移除：不该再出现在页面上
    assert.doesNotMatch(html, /USB 厂商/);
    assert.match(html, /测试设备（小幅试动）/);
    assert.match(html, /50% → 60% → 50%/);
    // 串口模式只显示串口参数，不显示 UDP 参数
    assert.doesNotMatch(html, /UDP 端口/);
  } finally {
    if (hadRequire) globalThis.require = previousRequire;
    else delete globalThis.require;
    studioSettings.clear();
  }
});

test("the editor view falls back to browser authorization when the host has no Node", () => {
  studioSettings.clear();
  studioSettings.set("osr6.transport", "serial");
  try {
    const html = renderToStaticMarkup(React.createElement(StudioSettingsPage));
    assert.match(html, /添加串口…/);
    assert.doesNotMatch(html, /刷新系统串口/);
    assert.doesNotMatch(html, /UDP 端口/);
  } finally {
    studioSettings.clear();
  }
});

test("editor native selection queries and releases a port using bundled serialport", async () => {
  const bridge = nativeBridge(); const modules = [];
  const api = createStudioSerialApi({ require(name) { modules.push(name); return bridge.host.require(name); } });
  resources.push(() => api.dispose());
  const [port] = await api.getPorts();
  assert.match(port.displayName, /COM3/);
  assert.deepEqual(await probeSerialDevice({ api, selectedPort: port, baudRate: 115200 }), { ok: true, detail: "Native OSR" });
  assert.deepEqual([...new Set(modules)], builtinNames.map((name) => "node:" + name));
  assert.equal(bridge.requests.at(-1).action, "close");
});
test("editor without native access reports the missing host capability", () => {
  assert.throws(() => createStudioSerialApi({}), /编辑器没有开放/);
});

test("native disposal during open closes a late connection and prevents motion", async () => {
  const bridge = nativeBridge(); const [port] = await bridge.api.getPorts();
  let finish;
  bridge.hooks.open = (complete) => { finish = complete; };
  const task = createSerialTransport({ api: bridge.api, selectedPort: port, baudRate: 115200 });
  const rejected = assert.rejects(task, /取消|结束/);
  await waitFor(() => !!finish);
  const disposed = bridge.api.dispose(); finish();
  await Promise.all([rejected, disposed]);
  assert.equal(bridge.requests.filter((request) => request.action === "write").length, 0);
  assert.equal(bridge.requests.filter((request) => request.action === "close").length, 1);
});

test("native write errors close the port and propagate to the transport", async () => {
  const bridge = nativeBridge(); const [port] = await bridge.api.getPorts();
  const transport = await createSerialTransport({ api: bridge.api, selectedPort: port, baudRate: 115200 });
  resources.push(() => transport.close());
  bridge.hooks.writeError = new Error("native write failed");
  transport.send("L05000\n");
  await assert.rejects(transport.drain(), /native write failed/);
  await waitFor(() => bridge.requests.some((request) => request.action === "close"));
  assert.equal(port.connected, false);
});

test("native Unix device paths and USB/Bluetooth metadata survive filtering and reordering", async () => {
  const bridge = nativeBridge([
    { path: "/dev/ttyUSB0", vendorId: "1a86", productId: "7523", serialNumber: "usb-1" },
    { path: "/dev/rfcomm0" },
    { path: "/dev/cu.OSR-Bluetooth", manufacturer: "OSR" },
  ]);
  const all = await bridge.api.getPorts(); bridge.rows.reverse();
  assert.deepEqual(await bridge.api.getPorts(), all);
  const usb = await listSerialDevices({ api: bridge.api, baudRate: 115200, kind: "usb" });
  assert.equal(usb.length, 1); assert.match(usb[0].label, /ttyUSB0/);
  const bluetooth = await listSerialDevices({ api: bridge.api, baudRate: 115200, kind: "bluetooth" });
  assert.equal(bluetooth.length, 2);
  assert.ok(bluetooth.every((item) => item.port.getInfo().bluetoothServiceClassId === 0x1101));
});

test("motion test ramps only L0, returns to center, waits for completion, then stops", async () => {
  const bridge = nativeBridge();
  const [port] = await bridge.api.getPorts();
  const result = await testSerialDevice({ api: bridge.api, selectedPort: port, baudRate: 115200 });
  assert.deepEqual(result, { ok: true, detail: "Native OSR", motion: true });
  const commands = bridge.requests.filter((item) => item.action === "write").map((item) => Buffer.from(item.data, "base64").toString());
  assert.deepEqual(commands, ["D0\n", "L05000I600\n", "L05999I600\n", "L05000I600\n", "DSTOP\n"]);
  assert.equal(bridge.requests.at(-1).action, "close");
});

test("cancelling a motion test stops it without scheduling the remaining motion", async () => {
  const abort = new AbortController();
  const port = fakePort(undefined, { write(text, port) {
    if (text === "D0\n") port.readerController.enqueue(new TextEncoder().encode("OSR test\n"));
    if (text === "L05999I600\n") abort.abort();
  } });
  serialApi([port]);
  await assert.rejects(testSerialDevice({ selectedPort: port, baudRate: 115200 }, abort.signal), /取消/);
  assert.equal(port.closes, 1);
  assert.equal(port.writes.filter((text) => text === "L05000I600\n").length, 1, "no new motion after cancellation");
  assert.equal(port.writes.at(-1), "DSTOP\n");
  // 中止不会永久占用端口；之后仍可执行身份查询。
  assert.equal((await probeSerialDevice({ selectedPort: port, baudRate: 115200 })).ok, true);
});

test("a motion write failure rejects the test and closes the port", async () => {
  const port = fakePort(undefined, { write(text, port) {
    if (text === "D0\n") port.readerController.enqueue(new TextEncoder().encode("OSR test\n"));
    if (text === "L05999I600\n") throw new Error("motion write failed");
  } });
  serialApi([port]);
  await assert.rejects(testSerialDevice({ selectedPort: port, baudRate: 115200 }), /motion write failed/);
  assert.equal(port.closes, 1);
  assert.equal(port.writes.filter((text) => text === "L05000I600\n").length, 1);
});

test("cancelling during the identity query never starts motion", async () => {
  const abort = new AbortController(); const port = fakePort(); serialApi([port]);
  const pending = testSerialDevice({ selectedPort: port, baudRate: 115200 }, abort.signal);
  const rejected = assert.rejects(pending, /取消/);
  await waitFor(() => port.writes.includes("D0\n")); abort.abort();
  await rejected;
  assert.deepEqual(port.writes, ["D0\n"]);
  assert.equal(port.closes, 1);
});

test("an explicitly disabled axis list never falls back to the default six axes", async () => {
  const port = fakePort(); serialApi([port]); const value = engine();
  await value.connect(settings({ axes: [{ axis: "L0", enabled: false, invert: false }] }));
  value.setAxis("L0", 0.8); value.setAxis("L1", 0.9, 600);
  value.setAxisExact("L0", 0.8); value.setAxes([{ axis: "R0", value: 0.7 }]); value.recenter();
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(port.writes, []);
});

test("disabled or unlisted axes are ignored by all position APIs without waking other axes", async () => {
  const port = fakePort(); serialApi([port]); const value = engine();
  await value.connect(settings({ axes: [
    { axis: "L0", enabled: true, invert: true }, { axis: "L1", enabled: false, invert: false },
  ] }));
  for (const axis of ["L1", "R0"]) {
    value.setAxis(axis, 0.8); value.setAxis(axis, 0.8, 600); value.setAxisExact(axis, 0.8);
    value.setAxes([{ axis, value: 0.8 }]);
  }
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.deepEqual(port.writes, []);
  value.setAxis("L0", 0.8, 600); await turn();
  assert.deepEqual(port.writes, ["L02000I600\n"], "enabled axes still honor inversion and ramping");
});

const playbackParams = { scripts: [{ axis: "L0", asset: "bgm/test.wav" }], loop: false, startMs: 0, invert: false, interpolation: "linear" };
function assetResponse(pos = 80, duration = 10000) {
  const bytes = encodeCarrierWav(JSON.stringify({ actions: [{ at: 0, pos }, { at: duration, pos }] }));
  return { ok: true, arrayBuffer: async () => bytes.buffer };
}
function mockAssets(ctx, fetcher) {
  const original = globalThis.fetch;
  ctx.asset = { resolve: (ref) => ({ url: ref }) };
  globalThis.fetch = fetcher;
  resources.push(() => { globalThis.fetch = original; });
}
for (const action of ["stop", "stopScript", "disconnect", "connect", "preview-exit"]) {
  test(`${action} cancels an in-flight asset and rejects even a late response that ignores abort`, async () => {
    const port = fakePort(); serialApi([port]); const { ctx, abort } = context();
    await Extension.connect.run(ctx);
    const response = deferred(); let requestSignal;
    mockAssets(ctx, async (_, options) => { requestSignal = options.signal; return response.promise; });
    const playing = Extension.playScript.run(ctx, playbackParams);
    const rejected = assert.rejects(playing, /取消/);
    if (action === "preview-exit") abort.abort(); else await Extension[action].run(ctx);
    assert.equal(requestSignal.aborted, true);
    response.resolve(assetResponse(90)); await rejected; await turn();
    assert.equal(runtimeForSignal(abort.signal).activePlaybacks.length, 0);
    assert.ok(!port.writes.some((text) => text.includes("L08999")), "late asset must never start motion");
  });
}

test("a newer play request wins when the previous asset finishes later", async () => {
  const port = fakePort(); serialApi([port]); const { ctx, abort } = context(); await Extension.connect.run(ctx);
  const oldResponse = deferred(); let first = true;
  mockAssets(ctx, async () => { if (first) { first = false; return oldResponse.promise; } return assetResponse(90); });
  const oldPlay = Extension.playScript.run(ctx, playbackParams); const rejected = assert.rejects(oldPlay, /取消/);
  await Extension.playScript.run(ctx, playbackParams); oldResponse.resolve(assetResponse(80)); await rejected; await turn();
  assert.equal(runtimeForSignal(abort.signal).activePlaybacks.length, 1);
  assert.ok(port.writes.some((text) => text.includes("L08999")));
  assert.ok(!port.writes.some((text) => text.includes("L07999")));
});

test("natural completion of the previous group does not cancel a replacement asset load", async () => {
  const port = fakePort(); serialApi([port]); const { ctx, abort } = context(); await Extension.connect.run(ctx);
  const nextResponse = deferred(); let first = true;
  mockAssets(ctx, async () => { if (first) { first = false; return assetResponse(80, 10); } return nextResponse.promise; });
  await Extension.playScript.run(ctx, playbackParams);
  const nextPlay = Extension.playScript.run(ctx, playbackParams);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  nextResponse.resolve(assetResponse(90)); await nextPlay; await turn();
  assert.equal(runtimeForSignal(abort.signal).activePlaybacks.length, 1);
  assert.ok(port.writes.some((text) => text.includes("L08999")));
});

test("starting playback clears delayed test motion before handing control to the script", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const port = fakePort(); serialApi([port]); const { ctx, abort } = context();
  mockAssets(ctx, async () => assetResponse());
  await Extension.testDevice.run(ctx);
  await Extension.playScript.run(ctx, playbackParams); await turn();
  assert.equal(runtimeForSignal(abort.signal).testTimers.size, 0);
  const before = port.writes.slice(); t.mock.timers.tick(1000); await turn();
  assert.deepEqual(port.writes, before);
  assert.ok(port.writes.includes("L07999\n"));
});

test("strength changes refresh a constant segment immediately and respect pause", async () => {
  const port = fakePort(); serialApi([port]); const { ctx } = context({ axes: [{ axis: "L0", enabled: true, invert: false }] });
  mockAssets(ctx, async () => assetResponse()); await Extension.connect.run(ctx);
  await Extension.playScript.run(ctx, playbackParams); await turn();
  Extension.setStrength.run(ctx, { ranges: [{ axis: "L0", min: 0, max: 50 }] }); await turn();
  assert.equal(port.writes.at(-1), "L04000\n");
  Extension.pauseScript.run(ctx); const count = port.writes.length;
  Extension.setStrength.run(ctx, { ranges: [{ axis: "L0", min: 0, max: 25 }] }); await turn();
  assert.equal(port.writes.length, count, "changing strength while paused must not move the device");
  Extension.resumeScript.run(ctx); await waitFor(() => port.writes.at(-1) === "L02000\n");
});

function mockUdpProbe(onSend) {
  const writes = []; let closed = false;
  return { writes, get closed() { return closed; }, dgram: { createSocket() { return {
    on() {}, send(text, port, host, callback) { writes.push(text); if (onSend) onSend(text, callback); else callback(null); },
    close() { closed = true; },
  }; } } };
}
for (const cancelAt of [30, 120, 800]) {
  test(`UDP test cancellation at ${cancelAt}ms sends stop and cancels every later movement`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const mock = mockUdpProbe(); const abort = new AbortController();
    const task = probeUdpDevice({ ...mock, host: "mock", port: 8000, signal: abort.signal });
    t.mock.timers.tick(cancelAt); abort.abort(); const result = await task;
    assert.equal(result.cancelled, true); assert.equal(mock.writes.at(-1), "DSTOP\n"); assert.equal(mock.closed, true);
    const count = mock.writes.length; t.mock.timers.tick(5000); assert.equal(mock.writes.length, count);
  });
}
test("UDP test waits for the final stop send before closing its socket", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let sentStop;
  const mock = mockUdpProbe((text, callback) => { if (text === "DSTOP\n") sentStop = callback; else callback(null); });
  const task = probeUdpDevice({ ...mock, host: "mock", port: 8000 });
  t.mock.timers.tick(2400);
  assert.deepEqual(mock.writes, ["D0\n", "L05000I300\n", "L06500I600\n", "L05000I600\n", "DSTOP\n"]);
  assert.equal(mock.closed, false); sentStop(null); assert.equal((await task).ok, true); assert.equal(mock.closed, true);
});
test("UDP stop failure still closes the socket and is not reported as success", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mock = mockUdpProbe((text, callback) => { if (text !== "DSTOP\n") callback(null); });
  const task = probeUdpDevice({ ...mock, host: "mock", port: 8000 });
  t.mock.timers.tick(2400); t.mock.timers.tick(500); const result = await task;
  assert.equal(result.ok, false); assert.match(result.detail, /超时/); assert.equal(mock.closed, true);
});
