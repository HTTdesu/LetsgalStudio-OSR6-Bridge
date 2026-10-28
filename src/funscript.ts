/**
 * Funscript 解析与采样。
 *
 * 格式（funscript 1.0 / 1.1 的通用部分）：
 *
 * ```json
 * {
 *   "version": "1.0",
 *   "inverted": false,
 *   "range": 90,
 *   "actions": [ { "at": 0, "pos": 0 }, { "at": 250, "pos": 100 } ],
 *   "metadata": { ... }
 * }
 * ```
 *
 * - `at`：相对脚本开头的毫秒时间戳；
 * - `pos`：0-100 的位置，0 与 100 对应设备的两个端点；
 * - 两点之间是线性插值（v1.1 的 easing 扩展暂不处理）。
 *
 * 这里只负责「把一段 JSON 文本变成可查询的时间轴」，不碰设备、不碰时钟，
 * 方便单独测试。
 */

export interface FunscriptAction {
  /** 毫秒，相对脚本开头。 */
  at: number;
  /** 0-100。 */
  pos: number;
}

export interface Funscript {
  version: string | null;
  inverted: boolean;
  range: number | null;
  durationMs: number;
  actions: FunscriptAction[];
  warnings: string[];
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * 把 funscript 文本解析成时间轴。
 *
 * 容错点（都是实际文件里见过的）：
 * - 顶层直接是 actions 数组（有些工具这样导出）；
 * - `at` / `pos` 写成字符串；
 * - 时间戳重复：保留后出现的那个；
 * - `pos` 超出 0-100：夹紧并记录警告。
 */
export function parseFunscript(text: string): Funscript {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error("funscript 内容为空。");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`funscript 不是合法 JSON：${reason}`);
  }

  let actionsRaw: unknown;
  let version: string | null = null;
  let inverted = false;
  let range: number | null = null;

  if (Array.isArray(raw)) {
    actionsRaw = raw;
  } else if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    actionsRaw = record.actions;
    if (typeof record.version === "string") version = record.version;
    inverted = record.inverted === true;
    range = toNumber(record.range);
  } else {
    throw new Error("funscript 顶层必须是对象或 actions 数组。");
  }

  if (!Array.isArray(actionsRaw)) {
    throw new Error("funscript 缺少 actions 数组。");
  }

  const warnings: string[] = [];
  const byTime = new Map<number, number>();
  let clamped = 0;

  for (const entry of actionsRaw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const at = toNumber(record.at);
    const pos = toNumber(record.pos);
    if (at === null || pos === null) continue;
    if (at < 0) continue;
    let clampedPos = pos;
    if (pos < 0 || pos > 100) {
      clampedPos = Math.min(100, Math.max(0, pos));
      clamped += 1;
    }
    byTime.set(Math.round(at), clampedPos);
  }

  if (clamped > 0) {
    warnings.push(`${clamped} 个动作的 pos 超出 0-100，已夹紧。`);
  }

  const actions: FunscriptAction[] = Array.from(byTime.entries())
    .map(([at, pos]) => ({ at, pos }))
    .sort((a, b) => a.at - b.at);

  if (actions.length === 0) {
    throw new Error("funscript 的 actions 为空，没有可播放的动作点。");
  }
  if (actions.length < 2) {
    warnings.push("只有 1 个动作点，播放时位置不会变化。");
  }

  const durationMs = actions[actions.length - 1].at;
  if (durationMs <= 0) {
    warnings.push("脚本时长为 0，可能所有动作点都在同一时刻。");
  }

  return {
    version,
    inverted,
    range,
    durationMs,
    actions,
    warnings,
  };
}

/**
 * 插值方式。与 MultiFunPlayer 的 InterpolationType 枚举一致
 * （源码 Source/MultiFunPlayer/Common/Utils/MathUtils.cs）：
 *
 * - `linear`：两点直线。最贴近原始数据，但折点处速度突变。
 * - `pchip`：分段三次 Hermite，斜率用 Fritsch–Carlson 加权调和平均，
 *   保单调、不过冲。MultiFunPlayer 的默认选项。
 * - `makima`：改进的 Akima，斜率用前后各两点加权，比 pchip 更平滑，
 *   但允许轻微过冲。
 * - `step`：保持左端点值，直到下一个动作点（阶梯）。
 */
export type InterpolationMode = "linear" | "pchip" | "makima" | "step";

export const INTERPOLATION_MODES: readonly InterpolationMode[] = [
  "linear",
  "pchip",
  "makima",
  "step",
];

export function isInterpolationMode(value: string): value is InterpolationMode {
  return (INTERPOLATION_MODES as readonly string[]).includes(value);
}

/** 三次 Hermite 基函数（与 MultiFunPlayer 的 Interpolation.CubicHermite 同式）。 */
function cubicHermite(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  s0: number,
  s1: number,
  x: number,
): number {
  const d = x1 - x0;
  const dx = x - x0;
  const t = dx / d;
  const r = 1 - t;
  return (
    r * r * (y0 * (1 + 2 * t) + s0 * dx) + t * t * (y1 * (3 - 2 * t) - d * s1 * r)
  );
}

/** PCHIP 斜率（Fritsch–Carlson 加权调和平均）。 */
function pchipSlopes(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
): { s1: number; s2: number } {
  const hkm1 = x1 - x0;
  const hk1 = x2 - x1;
  const hk2 = x3 - x2;
  if (hkm1 <= 0 || hk1 <= 0 || hk2 <= 0) {
    // 退化成重复点（脚本首尾常见），该段按线性处理。
    const slope = hk1 > 0 ? (y2 - y1) / hk1 : 0;
    return { s1: slope, s2: slope };
  }

  const dkm1 = (y1 - y0) / hkm1;
  const dk1 = (y2 - y1) / hk1;
  const dk2 = (y3 - y2) / hk2;

  const w11 = 2 * hk1 + hkm1;
  const w12 = hk1 + 2 * hkm1;
  let s1 = (w11 + w12) / (w11 / dkm1 + w12 / dk1);
  if (!Number.isFinite(s1) || dk1 * dkm1 < 0) s1 = 0;

  const w21 = 2 * hk2 + hk1;
  const w22 = hk2 + 2 * hk1;
  let s2 = (w21 + w22) / (w21 / dk1 + w22 / dk2);
  if (!Number.isFinite(s2) || dk2 * dk1 < 0) s2 = 0;

  return { s1, s2 };
}

/** MAKIMA 斜率（改进 Akima，前后各两点加权）。 */
function makimaSlopes(
  xs: readonly number[],
  ys: readonly number[],
): { s1: number; s2: number } {
  const [x0, x1, x2, x3, x4, x5] = xs;
  const [y0, y1, y2, y3, y4, y5] = ys;
  if (x1 <= x0 || x2 <= x1 || x3 <= x2 || x4 <= x3 || x5 <= x4) {
    const slope = x3 > x2 ? (y3 - y2) / (x3 - x2) : 0;
    return { s1: slope, s2: slope };
  }

  const m0 = (y1 - y0) / (x1 - x0);
  const m1 = (y2 - y1) / (x2 - x1);
  const m2 = (y3 - y2) / (x3 - x2);
  const m3 = (y4 - y3) / (x4 - x3);
  const m4 = (y5 - y4) / (x5 - x4);

  const w11 = Math.abs(m3 - m2) + Math.abs(m3 + m2) / 2;
  const w12 = Math.abs(m1 - m0) + Math.abs(m1 + m0) / 2;
  let s1 = (w11 * m1 + w12 * m2) / (w11 + w12);
  if (!Number.isFinite(s1)) s1 = 0;

  const w21 = Math.abs(m4 - m3) + Math.abs(m4 + m3) / 2;
  const w22 = Math.abs(m2 - m1) + Math.abs(m2 + m1) / 2;
  let s2 = (w21 * m2 + w22 * m3) / (w21 + w22);
  if (!Number.isFinite(s2)) s2 = 0;

  return { s1, s2 };
}

function clampIndex(index: number, length: number): number {
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}

/**
 * 取第 index 个动作点；越界时按端点做坐标反射。
 *
 * 直接用索引夹紧会出两个问题：越界的几个索引落到同一个点上（步长为 0），
 * 或者按索引镜像后 x 不再单调，斜率公式都会退化。按坐标反射能同时保住
 * 单调性和原有步长。
 */
function pointAt(
  actions: readonly FunscriptAction[],
  index: number,
): { at: number; pos: number } {
  const n = actions.length;
  if (index < 0) {
    const j = Math.min(-index, n - 1);
    return { at: 2 * actions[0].at - actions[j].at, pos: actions[j].pos };
  }
  if (index >= n) {
    const j = Math.max(2 * (n - 1) - index, 0);
    return { at: 2 * actions[n - 1].at - actions[j].at, pos: actions[j].pos };
  }
  return actions[index];
}

/**
 * 取某个时刻的位置，返回 0-1（已把 0-100 归一化）。
 *
 * 首点之前保持首点位置，末点之后保持末点位置。
 */
export function sampleFunscript(
  script: Funscript,
  timeMs: number,
  mode: InterpolationMode = "linear",
): number {
  const actions = script.actions;
  if (actions.length === 0) return 0;

  if (timeMs <= actions[0].at) return actions[0].pos / 100;
  const last = actions[actions.length - 1];
  if (timeMs >= last.at) return last.pos / 100;

  // 二分找最后一个 at <= timeMs 的动作点。
  let low = 0;
  let high = actions.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (actions[mid].at <= timeMs) low = mid;
    else high = mid - 1;
  }

  const from = actions[low];
  const to = actions[Math.min(low + 1, actions.length - 1)];
  const span = to.at - from.at;
  if (span <= 0) return to.pos / 100;

  if (mode === "step") return from.pos / 100;
  if (mode === "linear") {
    const ratio = (timeMs - from.at) / span;
    return (from.pos + (to.pos - from.pos) * ratio) / 100;
  }

  const y = (index: number) => pointAt(actions, index).pos / 100;
  const x = (index: number) => pointAt(actions, index).at;

  if (mode === "pchip") {
    const { s1, s2 } = pchipSlopes(
      x(low - 1),
      y(low - 1),
      from.at,
      y(low),
      to.at,
      y(low + 1),
      x(low + 2),
      y(low + 2),
    );
    const value = cubicHermite(from.at, y(low), to.at, y(low + 1), s1, s2, timeMs);
    // PCHIP 的定义就是保单调，理论上不会越过两端；这里再夹一次，防止
    // 长间隙段（例如脚本里 60 秒没有动作点）因斜率与跨度不匹配而飞出区间。
    const lo = Math.min(y(low), y(low + 1));
    const hi = Math.max(y(low), y(low + 1));
    return Math.min(hi, Math.max(lo, value));
  }

  // makima：插值区间是 [low, low+1]（对应 C# 的 x2..x3），前后各取两个邻点。
  const { s1, s2 } = makimaSlopes(
    [x(low - 2), x(low - 1), from.at, to.at, x(low + 2), x(low + 3)],
    [y(low - 2), y(low - 1), y(low), y(low + 1), y(low + 2), y(low + 3)],
  );
  const value = cubicHermite(from.at, y(low), to.at, y(low + 1), s1, s2, timeMs);
  // Makima 允许过冲，但长间隙段会过冲到数倍量程（实测到 5.1）。设备端只能
  // 接受 0-1，MFP 也是在输出前 Clamp01，这里同样夹紧。
  return Math.min(1, Math.max(0, value));
}

/** 给 UI / 状态输出用的一行摘要。 */
export function describeFunscript(script: Funscript): string {
  const seconds = (script.durationMs / 1000).toFixed(1);
  const parts = [
    `${script.actions.length} 个动作点`,
    `时长 ${seconds}s`,
    `版本 ${script.version ?? "未标注"}`,
  ];
  if (script.warnings.length > 0) {
    parts.push(`警告 ${script.warnings.length} 条`);
  }
  return parts.join("，");
}
