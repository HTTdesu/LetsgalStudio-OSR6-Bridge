/**
 * TCode 协议编码层。
 *
 * 规范来源：https://github.com/multiaxis/TCode-Specification （v0.4）
 *
 * - 基本命令 `X&$$`：`X` = 轴类型（L/R/V/A），`&` = 通道号，`$$` = 幅值数字，
 *   相当于省略小数点的 0.xx，例如 `L277` = 0.77。
 * - 扩展命令 `X&$$I£££`：`I` 后是爬升时间（毫秒），电机从当前值线性过渡到目标值。
 * - `DSTOP`：设备立即停止。
 * - 多轴可空格分隔写在同一行，收到 `\n` 才执行。
 * - 实时控制推荐使用「短命令 + 换行」，设备自带的平滑算法会处理帧间抖动。
 */

/** TCode 标准轴。前三位线性（上下/前后/左右），中间三位旋转，其后是振动与辅助通道。 */
export const TCODE_AXES = [
  "L0",
  "L1",
  "L2",
  "R0",
  "R1",
  "R2",
  "V0",
  "V1",
  "A0",
  "A1",
  "A2",
] as const;

export type TCodeAxis = (typeof TCODE_AXES)[number];

/** 各轴的中位/静息值：线性与旋转轴 0.5 为中位，振动与辅助轴 0 为关闭。 */
export const AXIS_NEUTRAL: Readonly<Record<TCodeAxis, number>> = {
  L0: 0.5,
  L1: 0.5,
  L2: 0.5,
  R0: 0.5,
  R1: 0.5,
  R2: 0.5,
  V0: 0,
  V1: 0,
  A0: 0,
  A1: 0,
  A2: 0,
};

export function isTCodeAxis(value: string): value is TCodeAxis {
  return (TCODE_AXES as readonly string[]).includes(value);
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 编码一条轴指令。
 *
 * 幅值统一用 4 位（0-9999），这是 TCode v0.3 设备通用的精度，
 * 各轴的最小/最大偏好由设备自己的 `D2` 命令控制。
 */
export function encodeAxis(
  axis: TCodeAxis,
  value01: number,
  intervalMs?: number,
): string {
  const magnitude = Math.round(clamp01(value01) * 9999);
  const digits = String(magnitude).padStart(4, "0");
  if (intervalMs !== undefined && intervalMs > 0) {
    return `${axis}${digits}I${Math.round(intervalMs)}`;
  }
  return `${axis}${digits}`;
}

/** 把若干轴指令拼成一行（以换行为结束符）。 */
export function encodeLine(parts: readonly string[]): string {
  return `${parts.join(" ")}\n`;
}

export const TCODE_STOP = "DSTOP";
