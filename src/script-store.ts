/**
 * 脚本登记表与「指针」解析。
 *
 * 设计前提：funscript 的真实内容不进剧本参数。剧本里只放一个短字符串，
 * 运行时再按它去内存里取内容。这就是我们说的「内存指针」：参数只是一个 key，
 * 数据在引擎内存里。
 *
 * 支持的指针写法（按顺序匹配）：
 *
 * 1. `asset:se/xxx.wav` —— 读取项目素材里的 WAV 载波（8-bit PCM，data 块里
 *    放 funscript 文本）。这是给真实内容用的：脚本以素材形式随工程走，
 *    参数里只留一个引用。
 * 2. `var:变量名` —— 从项目变量读字符串。适合用别的扩展/数据表把脚本塞进
 *    内存，剧本里只引用变量名。变量值也可以是已经解析好的对象。
 * 3. `global:键名` —— 从 `globalThis.__osr6Scripts` 读。适合宿主或你自己写的
 *    加载代码提前把内容挂到全局。
 * 4. 纯 id —— 本扩展 `注册 funscript` 登记过的名字。
 * 5. 内联 JSON —— 以 `{` 或 `[` 开头时直接当内容解析（测试和短脚本用）。
 *
 * 解析顺序固定，报错时会把尝试过的来源都列出来，方便排查。
 */

import { parseFunscript, type Funscript } from "./funscript";

export type ScriptSource = "asset" | "variable" | "global" | "inline";

export interface LoadedScript {
  script: Funscript;
  source: ScriptSource;
  ref: string;
}

export interface ScriptSources {
  /** 读项目素材（WAV 载波）并解出 funscript 文本，通常接 ctx.asset。 */
  readAsset?(ref: string): Promise<string>;
  /** 读项目变量，通常传 `(name) => ctx.variables.get(name)`。 */
  readVariable(name: string): unknown;
  /** 读全局登记表，通常传 `(name) => (globalThis as any).__osr6Scripts?.[name]`。 */
  readGlobal(name: string): unknown;
}


/** 素材载波解析结果缓存：同一个素材重复播放时不必再 fetch + 解一遍。 */
const assetCache = new Map<string, Funscript>();
const ASSET_CACHE_LIMIT = 16;

function asText(value: unknown): string | null {
  if (typeof value === "string") return value;
  // 允许变量里直接放已经解析成对象的数据，统一转回文本再走同一条解析路径。
  if (typeof value === "object" && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return null;
}

function parseOrThrow(text: string, where: string): Funscript {
  try {
    return parseFunscript(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${where}：${reason}`);
  }
}

export async function loadScript(
  ref: string,
  sources: ScriptSources,
): Promise<LoadedScript> {
  const raw = ref.trim();
  if (raw.length === 0) {
    throw new Error(
      "脚本引用为空：请传入 `asset:se/xxx.wav`、脚本名、`var:变量名` 或 `global:键名`。",
    );
  }

  if (raw.startsWith("asset:")) {
    const assetRef = raw.slice(6).trim();
    if (assetRef.length === 0) throw new Error("`asset:` 后面缺少素材路径。");
    if (!sources.readAsset) {
      throw new Error("当前宿主没有提供素材读取能力，无法使用 asset: 指针。");
    }

    const cached = assetCache.get(assetRef);
    if (cached) return { script: cached, source: "asset", ref: raw };

    let text: string;
    try {
      text = await sources.readAsset(assetRef);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`读取素材「${assetRef}」失败：${reason}`);
    }

    const script = parseOrThrow(text, `素材「${assetRef}」里的 funscript 解析失败`);
    if (assetCache.size >= ASSET_CACHE_LIMIT) {
      const oldest = assetCache.keys().next();
      if (!oldest.done) assetCache.delete(oldest.value);
    }
    assetCache.set(assetRef, script);
    return { script, source: "asset", ref: raw };
  }

  if (raw.startsWith("var:")) {
    const name = raw.slice(4).trim();
    if (name.length === 0) throw new Error("`var:` 后面缺少变量名。");
    const value = sources.readVariable(name);
    const text = asText(value);
    if (text === null) {
      throw new Error(
        `变量「${name}」不存在或不是字符串/对象，无法作为 funscript 内容。`,
      );
    }
    return { script: parseOrThrow(text, `变量「${name}」解析失败`), source: "variable", ref: raw };
  }

  if (raw.startsWith("global:")) {
    const name = raw.slice(7).trim();
    if (name.length === 0) throw new Error("`global:` 后面缺少键名。");
    const value = sources.readGlobal(name);
    const text = asText(value);
    if (text === null) {
      throw new Error(
        `globalThis.__osr6Scripts["${name}"] 不存在或不是字符串/对象。`,
      );
    }
    return { script: parseOrThrow(text, `全局脚本「${name}」解析失败`), source: "global", ref: raw };
  }

  // 直接给内容（测试、短脚本）。
  if (raw.startsWith("{") || raw.startsWith("[")) {
    return { script: parseOrThrow(raw, "内联 funscript 解析失败"), source: "inline", ref: raw };
  }

  // 兜底：名字刚好写在全局表里，但没写 `global:` 前缀。
  const globalValue = asText(sources.readGlobal(raw));
  if (globalValue !== null) {
    return {
      script: parseOrThrow(globalValue, `全局脚本「${raw}」解析失败`),
      source: "global",
      ref: raw,
    };
  }

  throw new Error(`找不到脚本「${raw}」。已尝试：素材（asset:）、变量（var:）、全局表（global:）。`);
}
