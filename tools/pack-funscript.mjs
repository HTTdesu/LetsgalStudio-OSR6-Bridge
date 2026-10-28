#!/usr/bin/env node
/**
 * 把一个 .funscript 打包成 Studio 能导入的 WAV 载波。
 *
 * 用法：
 *   npm run pack -- "路径/xxx.funscript"            → 同目录生成 xxx.wav
 *   npm run pack -- "路径/xxx.funscript" out.wav    → 指定输出
 *
 * 为什么需要这一步：Studio 的素材管线不接受 .funscript，只接受
 * assets/se/*.wav 这类音频。载波把 funscript 原文逐字节放进 WAV 的 data 块，
 * 运行时由扩展的「播放脚本素材」解回来。
 *
 * 编码实现复用 src/carrier.ts（先由 esbuild 编成 tools/carrier.mjs），
 * 保证打包端和解码端是同一份格式定义。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, basename, extname, resolve } from "node:path";
import { encodeCarrierWav, decodeCarrierWav } from "./carrier.mjs";

function fail(message) {
  console.error("错误：" + message);
  process.exit(1);
}

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg) {
  console.error("用法：npm run pack -- <input.funscript> [output.wav]");
  process.exit(1);
}

const input = resolve(inputArg);
if (!existsSync(input)) fail(`找不到输入文件：${input}`);
if (extname(input).toLowerCase() !== ".funscript") {
  fail(`输入不是 .funscript 文件：${input}`);
}

const text = readFileSync(input, "utf8");

// 先校验内容，避免把坏文件塞进工程才发现
let doc;
try {
  doc = JSON.parse(text);
} catch (error) {
  fail(`不是合法 JSON：${error.message}`);
}
const actions = Array.isArray(doc) ? doc : doc?.actions;
if (!Array.isArray(actions) || actions.length === 0) {
  fail("这个 funscript 没有 actions 数组，或数组为空。");
}

const output = outputArg
  ? resolve(outputArg)
  : join(dirname(input), basename(input, extname(input)) + ".wav");

const wav = encodeCarrierWav(text);
writeFileSync(output, wav);

// 立刻解一遍，确认打包结果能还原（防止压缩/编码环节出错）
const check = decodeCarrierWav(wav);
if (check.text !== text) fail("自检失败：解出来的内容和原文不一致。");

const seconds = (check.dataBytes / 44100).toFixed(2);
console.log("已生成：" + output);
console.log(
  `原文 ${Buffer.byteLength(text, "utf8")} 字节 → WAV ${wav.length} 字节` +
    `（data 块 ${check.dataBytes} 字节 ≈ ${seconds} 秒音频）`,
);
console.log(`动作点 ${actions.length} 个，最大时间 ${actions[actions.length - 1].at ?? "?"} ms`);
console.log("");
console.log("下一步：");
console.log("  1. 在 Studio 里把 " + basename(output) + " 导入 assets/se/");
console.log("  2. 选中它，把打包策略设为「强制打包」（未引用素材默认不进包）");
console.log("  3. 剧本里用「播放脚本素材」选中它，或写 asset:se/" + basename(output));
