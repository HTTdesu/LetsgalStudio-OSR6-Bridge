import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
export const serialportVirtualId = "virtual:osr6-serialport";

// Studio loads each entry from a single JS file. Bundle the npm code inside a
// lazy factory, injecting authorized Node built-ins only when desktop mode is used.
// Replace only the binary locator, leaving SerialPort's platform bindings intact.
export async function createSerialportBundle() {
  const bindingRoot = path.dirname(require.resolve("@serialport/bindings-cpp/package.json"));
  const binaryLoader = path.join(bindingRoot, "dist/serialport-bindings.js");
  const bundled = await build({
    stdin: { contents: 'module.exports = require("serialport").SerialPort;', resolveDir: path.dirname(require.resolve("serialport/package.json")) },
    bundle: true, platform: "node", format: "cjs", target: "node20", write: false,
    plugins: [{ name: "embedded-serialport-binding", setup(build) {
      build.onLoad({ filter: /serialport-bindings\.js$/ }, (args) => {
        if (path.resolve(args.path) !== binaryLoader) return;
        return { contents: "exports.binding = nativeBinding;", loader: "js" };
      });
    } }],
  });
  const binaries = [];
  const prebuilds = path.join(bindingRoot, "prebuilds");
  // Android 预编译用不上：游戏内宿主是 WebView，没有 Node，不走这条通道。
  const skipPlatforms = new Set(["android"]);
  for (const directory of (await readdir(prebuilds)).sort()) {
    const [platform, architectures] = directory.split("-");
    if (skipPlatforms.has(platform)) continue;
    for (const file of (await readdir(path.join(prebuilds, directory))).sort()) {
      if (!file.endsWith(".node")) continue;
      const bytes = await readFile(path.join(prebuilds, directory, file));
      binaries.push({ platform, architectures: architectures.split("+"),
        armVersion: /\.armv(\d+)\./.exec(file)?.[1], libc: /\.(glibc|musl)\./.exec(file)?.[1],
        sha256: createHash("sha256").update(bytes).digest("hex"), gzip: gzipSync(bytes).toString("base64") });
    }
  }
  if (!binaries.length) throw new Error("serialport prebuilt drivers are missing; restore npm dependencies before building.");
  return `export const binaries = ${JSON.stringify(binaries)};\n` +
    `export function createSerialPort(require, process, Buffer, nativeBinding) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${bundled.outputFiles[0].text}\nreturn module.exports;\n}\n`;
}

export function serialportBundlePlugin() {
  let notices;
  return { name: "osr6-embedded-serialport",
    async buildStart() { notices = await serialportNotices(); },
    resolveId(id) { if (id === serialportVirtualId) return "\0" + id; },
    async load(id) { if (id === "\0" + serialportVirtualId) return createSerialportBundle(); },
    generateBundle() { this.emitFile({ type: "asset", fileName: "serialport-LICENSES.txt", source: notices }); },
  };
}

async function serialportNotices() {
  const seen = new Set();
  const sections = [];
  async function visit(manifestPath) {
    if (seen.has(manifestPath)) return;
    seen.add(manifestPath);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const directory = path.dirname(manifestPath);
    const license = (await readdir(directory)).find((name) => /^licen[cs]e(?:\.txt|\.md)?$/i.test(name));
    if (!license) throw new Error(`License file missing for ${manifest.name}`);
    sections.push(`${manifest.name}@${manifest.version}\n${await readFile(path.join(directory, license), "utf8")}`);
    const localRequire = createRequire(manifestPath);
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      // Some packages export their API but intentionally hide package.json.
      let current = path.dirname(localRequire.resolve(dependency));
      let dependencyManifest;
      while (current !== path.dirname(current)) {
        const candidate = path.join(current, "package.json");
        try {
          if (JSON.parse(await readFile(candidate, "utf8")).name === dependency) { dependencyManifest = candidate; break; }
        } catch { /* Walk from the resolved entry to its package root. */ }
        current = path.dirname(current);
      }
      if (!dependencyManifest) throw new Error(`Package manifest missing for ${dependency}`);
      await visit(dependencyManifest);
    }
  }
  await visit(require.resolve("serialport/package.json"));
  return sections.join("\n\n---\n\n");
}
