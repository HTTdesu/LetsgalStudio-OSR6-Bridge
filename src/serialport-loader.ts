import { binaries, createSerialPort, type EmbeddedBinary } from "virtual:osr6-serialport";

export interface SerialportNodeModules {
  process: NodeJS.Process;
  buffer: typeof import("node:buffer");
  fs: typeof import("node:fs");
  os: typeof import("node:os");
  path: typeof import("node:path");
  crypto: typeof import("node:crypto");
  zlib: typeof import("node:zlib");
  stream: typeof import("node:stream");
  events: typeof import("node:events");
  util: typeof import("node:util");
  tty: typeof import("node:tty");
  child_process: typeof import("node:child_process");
}

// Cache only the stateless driver constructor. Device ownership remains scoped
// to each editor/preview session in NativeSerialApi.
const loaded = new WeakMap<NodeJS.Process, typeof import("serialport").SerialPort>();

export function selectSerialportBinary(platform: string, arch: string, libc?: string, armVersion?: string): EmbeddedBinary {
  const found = binaries.find((entry) => entry.platform === platform && entry.architectures.includes(arch)
    && (!entry.libc || entry.libc === libc) && (!entry.armVersion || entry.armVersion === armVersion));
  if (!found) throw new Error(`扩展未包含 ${platform}/${arch}${libc ? "/" + libc : ""} 的串口驱动，请使用浏览器授权或为该平台重新构建。`);
  return found;
}

export function loadSerialPort(modules: SerialportNodeModules): typeof import("serialport").SerialPort {
  const { process, fs, os, path, crypto, zlib, buffer: { Buffer } } = modules;
  const cached = loaded.get(process);
  if (cached) return cached;
  if (Number(process.versions.node?.split(".")[0]) < 20) throw new Error("serialport 13 需要 Node 20+，请更新桌面宿主或使用浏览器授权。");
  if (!Number.isInteger(Number(process.versions.napi)) || Number(process.versions.napi) < 6) {
    throw new Error("桌面串口需要支持 Node-API 6 的宿主，请更新 Studio。面板也可改用浏览器授权。");
  }
  let libc: string | undefined;
  if (process.platform === "linux") {
    const report = process.report?.getReport();
    const header = typeof report === "object" && report !== null && "header" in report ? report.header : undefined;
    libc = typeof header === "object" && header !== null
      ? ("glibcVersionRuntime" in header ? "glibc" : "musl")
      : (fs.existsSync("/etc/alpine-release") ? "musl" : "glibc");
  }
  const variables = process.config.variables as typeof process.config.variables & { arm_version?: number | string };
  const armVersion = process.arch === "arm64" ? "8" : String(variables.arm_version ?? "7");
  const binary = selectSerialportBinary(process.platform, process.arch, libc, armVersion);
  const bytes = zlib.gunzipSync(Buffer.from(binary.gzip, "base64"));
  const hash = (data: Uint8Array) => crypto.createHash("sha256").update(data).digest("hex");
  if (hash(bytes) !== binary.sha256) throw new Error("扩展内的串口驱动校验失败，请重新构建扩展。");

  // The native addon needs a real filesystem path, even when the extension was
  // loaded from a blob/packed game. No dependency on cwd, node_modules or network.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "osr6-serialport-"));
  const filename = path.join(directory, binary.sha256 + ".node");
  try {
    fs.writeFileSync(filename, bytes, { flag: "wx", mode: 0o600 });
    const nativeModule = { exports: {} };
    process.dlopen(nativeModule, filename);
    const SerialPort = createSerialPort((name) => {
      const key = name.replace(/^node:/, "");
      if (!Object.prototype.hasOwnProperty.call(modules, key)) throw new Error("未提供串口依赖的 Node 内置模块：" + name);
      return modules[key as keyof SerialportNodeModules];
    }, process, Buffer, nativeModule.exports);
    loaded.set(process, SerialPort);
    // Unix permits unlinking a loaded library. Windows may keep it locked until
    // host exit; retry at exit, and leave any still-locked file to OS temp cleanup.
    const cleanup = () => {
      try { fs.unlinkSync(filename); fs.rmdirSync(directory); return true; } catch { return false; }
    };
    if (!cleanup()) process.once("exit", () => { cleanup(); });
    return SerialPort;
  } catch (error) {
    try { fs.unlinkSync(filename); fs.rmdirSync(directory); } catch { /* Windows may already have mapped the library. */ }
    throw new Error(`桌面串口驱动加载失败（${process.platform}/${process.arch}）：${error instanceof Error ? error.message : String(error)}`);
  }
}
