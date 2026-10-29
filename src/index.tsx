import { Extension, extension, settings, type ExtensionContext } from "@avg-studio/sdk";
import { decodeCarrierWav } from "./carrier";
import { type Osr6AxisSetting, type Osr6Settings } from "./engine";
import { runtimeForSignal, type RuntimeState } from "./runtime-state";
import { SerialDevicePicker, type SerialDevicePickerProps } from "./serial-device-picker";
import { errorMessage, parseUsbId, serialBackend, serialKind, SerialSelectionRequiredError, type SerialBackend, type SerialOptions } from "./transport";
import { NativeSerialApi } from "./native-serial";
import { loadSerialPort, type SerialportNodeModules } from "./serialport-loader";
import {
  describeFunscript,
  isInterpolationMode,
  parseFunscript,
  type Funscript,
  type InterpolationMode,
} from "./funscript";
import { FunscriptPlayer } from "./player";
import {
  loadScript,
  type ScriptSources,
} from "./script-store";
import { isTCodeAxis, TCODE_AXES, type TCodeAxis } from "./tcode";

/**
 * 跟随脚本运行周期的取消信号。
 *
 * `ctx.flow.signal` 在 softReset / destroy（离开预览、重载、停止运行）时会被取消，
 * 这就是"离开预览"的那个回调。它一触发就停止播放并让设备停住，避免预览关掉后
 * 设备还在动。
 */
function getRuntime(ctx: { flow?: { signal?: AbortSignal } }): RuntimeState {
  const signal = ctx.flow?.signal;
  if (!signal) throw new Error("当前 SDK 没有提供运行周期信号，请同步 SDK。");
  return runtimeForSignal(signal);
}

/** 组里的一条脚本：驱动哪个轴、播什么、显示用的名字。 */
interface GroupItem {
  axis: TCodeAxis;
  script: Funscript;
  label: string;
}

/** 0-100 的百分比转成 0-1，越界值夹紧；缺省按 0 / 100 处理。 */
function percentToFraction(value: number | undefined, fallback = 0): number {
  const raw = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(1, Math.max(0, raw / 100));
}

/** 每个轴的强度范围（0-1 区间），由「设置强度范围」写入；未设置的轴按 0-1 满幅。 */
function strengthFor(runtime: RuntimeState, axis: TCodeAxis): { min: number; max: number } {
  return runtime.strengthRanges.get(axis) ?? { min: 0, max: 1 };
}

/** 插值方式的取值顺序：参数 > 项目设置 > pchip。 */
function resolveInterpolation(
  ctx: { settings: { get<T>(key: string): T | undefined } },
  requested: string,
): InterpolationMode {
  if (requested !== "auto" && isInterpolationMode(requested)) return requested;
  const configured = readRaw(ctx, "scriptInterpolation");
  return typeof configured === "string" && isInterpolationMode(configured)
    ? configured
    : "pchip";
}

/** 每 2 秒打一条心跳：每个轴的进度 + 实际下发帧数，用来判断循环有没有被打断。 */
/**
 * 播放看门狗：所有播放器都结束后收尾。
 *
 * 发布版不打周期性日志（之前每 2 秒一条会刷满宿主控制台），只保留结束时的
 * 一行记录；真正的错误由各方法自己打印。
 */
function startPlaybackWatchdog(runtime: RuntimeState): void {
  if (runtime.playbackHeartbeat !== null) clearInterval(runtime.playbackHeartbeat);
  runtime.playbackHeartbeat = setInterval(() => {
    if (!runtime.engine.connected || runtime.activePlaybacks.length === 0) {
      runtime.stopPlaybacks(!runtime.engine.connected);
      return;
    }
    if (runtime.activePlaybacks.every((item) => !item.player.state().active)) {
      runtime.stopPlaybacks(false);
      console.log("[osr6] playback finished");
    }
  }, 1000);
}

/**
 * 开始播放一组脚本：每个轴一个播放器，同时开播。
 *
 * 单脚本就是长度 1 的组。同一个轴不能在一次调用里出现两次（后写的会覆盖先写的）。
 */
function startGroup(
  ctx: { settings: { get<T>(key: string): T | undefined }; flow?: { signal?: AbortSignal } },
  items: GroupItem[],
  params: GroupPlaybackParams,
  groupLabel: string,
): string {
  const runtime = getRuntime(ctx);
  const target = runtime.engine;
  if (!target.connected) {
    throw new Error("设备尚未连接：请先调用「连接 OSR6」，再播放脚本。");
  }
  if (items.length === 0) {
    throw new Error("脚本组为空：至少要提供一条脚本。");
  }

  const seen = new Set<TCodeAxis>();
  for (const item of items) {
    if (seen.has(item.axis)) {
      throw new Error(`脚本组里轴 ${item.axis} 出现了两次，请合并成一条。`);
    }
    seen.add(item.axis);
  }

  const interpolation = resolveInterpolation(ctx, params.interpolation);
  const hz = readNumber(ctx, "playbackHz", 100, 10, 120);

  runtime.clearTestTimers();
  target.stop();
  runtime.stopPlaybacks();
  for (const item of items) {
    const player = new FunscriptPlayer();
    player.play(
      item.script,
      {
        axis: item.axis,
        loop: params.loop,
        speed: runtime.playbackSpeed,
        startMs: params.startMs,
        invert: params.invert,
        interpolation,
      },
      // 强度重映射：每帧按该轴当前的范围取值，所以播放中改强度也会立即生效。
      (sinkAxis, value) => {
        const range = strengthFor(runtime, sinkAxis);
        target.setAxisExact(sinkAxis, range.min + (range.max - range.min) * value);
      },
      hz,
    );
    runtime.activePlaybacks.push({ axis: item.axis, player, label: item.label });
  }

  startPlaybackWatchdog(runtime);
  console.log(
    "[osr6] play group [" + runtime.activePlaybacks.map((item) => item.axis).join(",") + "] hz=" + hz,
  );

  const summary = items
    .map((item) => {
      const range = strengthFor(runtime, item.axis);
      const label =
        Math.abs(range.min) < 1e-9 && Math.abs(range.max - 1) < 1e-9
          ? ""
          : `，强度 ${Math.round(range.min * 100)}–${Math.round(range.max * 100)}%`;
      return `${item.axis}(${describeFunscript(item.script)}${label})`;
    })
    .join("；");
  return `正在播放 ${items.length} 条脚本${groupLabel}，插值 ${interpolation}${
    params.loop ? "（循环）" : ""
  }：${summary}`;
}

/** 本扩展的模块 id —— 设置的完整名是「模块 id.字段名」。 */
const MODULE_ID = "osr6";

/**
 * 读设置。SDK 会按当前作用域补前缀，但不同宿主版本的补法有过差异，
 * 这里两种写法都试一次，避免用户改了设置却不生效。
 */
function readRaw(ctx: { settings: { get<T>(key: string): T | undefined } }, key: string): unknown {
  const scoped = ctx.settings.get<unknown>(`${MODULE_ID}.${key}`);
  if (scoped !== undefined) return scoped;
  return ctx.settings.get<unknown>(key);
}

function readString(ctx: { settings: { get<T>(key: string): T | undefined } }, key: string, fallback: string): string {
  const value = readRaw(ctx, key);
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readNumber(
  ctx: { settings: { get<T>(key: string): T | undefined } },
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = readRaw(ctx, key);
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, numeric));
}

function readAxes(ctx: { settings: { get<T>(key: string): T | undefined } }): Osr6AxisSetting[] {
  const raw = readRaw(ctx, "axes");
  if (!Array.isArray(raw)) return [];
  const rows: Osr6AxisSetting[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const axis = typeof record.axis === "string" ? record.axis : "";
    if (!isTCodeAxis(axis)) continue;
    rows.push({
      axis,
      enabled: record.enabled !== false,
      invert: record.invert === true,
    });
  }
  return rows;
}

function readSettings(ctx: {
  settings: { get<T>(key: string): T | undefined };
  variables?: { get(name: string): unknown };
}): Osr6Settings {
  const transport = readRaw(ctx, "transport");
  const playerHost = readDeviceHost(ctx);
  const playerPort = readDevicePort(ctx);
  const playerTransport = readDeviceTransport(ctx);
  const playerSerialIndex = readNumberVariable(ctx, "OSR6串口序号");
  const playerBaudRate = readNumberVariable(ctx, "OSR6波特率");
  return {
    // 玩家选过连接方式就用玩家的，否则跟随作者设置。
    transport:
      playerTransport !== ""
        ? playerTransport
        : transport === "serial"
          ? "serial"
          : "udp",
    udpHost: playerHost.length > 0 ? playerHost : readString(ctx, "udpHost", "192.168.1.1"),
    udpPort:
      playerPort >= 1 && playerPort <= 65535
        ? playerPort
        : Math.round(readNumber(ctx, "udpPort", 8000, 1, 65535)),
    serialVendorId: readString(ctx, "serialVendorId", ""),
    serialProductId: readString(ctx, "serialProductId", ""),
    serialKind: serialKind(ctx.variables?.get("OSR6串口类型") || readRaw(ctx, "serialKind")),
    serialBackend: serialBackend(ctx.variables?.get("OSR6串口访问方式") || readRaw(ctx, "serialBackend")),
    serialPortIndex:
      playerSerialIndex >= 0 && playerSerialIndex <= 9
        ? Math.round(playerSerialIndex)
        : Math.round(readNumber(ctx, "serialPortIndex", 0, 0, 9)),
    baudRate:
      playerBaudRate >= 1200 && playerBaudRate <= 921600
        ? Math.round(playerBaudRate)
        : Math.round(readNumber(ctx, "baudRate", 115200, 1200, 921600)),
    updateHz: Math.round(readNumber(ctx, "updateHz", 30, 1, 60)),
    smoothing: readNumber(ctx, "smoothing", 0.35, 0, 0.95),
    idleStopMs: Math.round(readNumber(ctx, "idleStopMs", 0, 0, 600000)),
    axes: readAxes(ctx),
  };
}

const AXIS_OPTIONS = TCODE_AXES.map((axis) => ({ value: axis, label: axis }));

/**
 * 玩家侧设备配置存在这几个项目变量里（persistence: shared，跨存档）。
 *
 * 作者在 Studio 里配的 transport / udpHost / udpPort 只是默认值；玩家改过就以变量为准。
 * 界面文档和方法都读写同一份变量，不需要额外的存档字段。
 */
const DEVICE_HOST_VARIABLE = "OSR6设备地址";
const DEVICE_PORT_VARIABLE = "OSR6设备端口";
/** 玩家选择的连接方式："udp" / "serial"；空串 = 跟随作者设置。 */
const DEVICE_TRANSPORT_VARIABLE = "OSR6连接方式";

/** 读玩家设置的地址；没设过返回空串。 */
function readDeviceHost(ctx: {
  variables?: { get(name: string): unknown };
}): string {
  const value = ctx.variables?.get(DEVICE_HOST_VARIABLE);
  return typeof value === "string" ? value.trim() : "";
}

/** 把变量值转成数字：接受 number 或数字字符串；转不出来返回 NaN。 */
function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

/** 读玩家设置的端口；没设过返回 0。 */
function readDevicePort(ctx: {
  variables?: { get(name: string): unknown };
}): number {
  const value = toNumber(ctx.variables?.get(DEVICE_PORT_VARIABLE));
  return Number.isFinite(value) ? Math.round(value) : 0;
}

/** 读一个数字玩家变量（接受数字或数字字符串）；没设过返回 NaN。 */
function readNumberVariable(
  ctx: { variables?: { get(name: string): unknown } },
  name: string,
): number {
  return toNumber(ctx.variables?.get(name));
}
/** 读玩家选择的连接方式；没设过或不是合法值时返回空串（表示跟随作者设置）。 */
function readDeviceTransport(ctx: {
  variables?: { get(name: string): unknown };
}): "" | "udp" | "serial" {
  const value = ctx.variables?.get(DEVICE_TRANSPORT_VARIABLE);
  return value === "udp" || value === "serial" ? value : "";
}

/**
 * 脚本指针的取值来源：项目素材（WAV 载波）+ 项目变量 + 全局表。
 *
 * 全局表约定为 `globalThis.__osr6Scripts`，一个「名字 → funscript 文本（或已解析对象）」
 * 的普通对象或 Map。任何能执行 JS 的加载逻辑都可以往里放东西，剧本里只留名字。
 */
function scriptSources(ctx: {
  variables: { get(name: string): unknown };
  asset: { resolve(uri: string): { url: string } };
}, signal?: AbortSignal): ScriptSources {
  return {
    async readAsset(ref: string): Promise<string> {
      const { url } = ctx.asset.resolve(ref);
      let response: Response;
      try {
        response = await fetch(url, { signal });
      } catch (error) {
        if (signal?.aborted) throw new Error("脚本播放已取消。");
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`无法访问素材地址（${reason}）`);
      }
      if (!response.ok) {
        throw new Error(`素材请求失败：HTTP ${response.status}`);
      }
      const buffer = await response.arrayBuffer();
      return decodeCarrierWav(buffer).text;
    },
    readVariable(name: string): unknown {
      return ctx.variables.get(name);
    },
    readGlobal(name: string): unknown {
      const store = (globalThis as unknown as { __osr6Scripts?: unknown }).__osr6Scripts;
      if (store instanceof Map) return store.get(name);
      if (typeof store === "object" && store !== null) {
        return (store as Record<string, unknown>)[name];
      }
      return undefined;
    },
  };
}

/**
 * 播放相关的公共参数，供「播放 funscript」和「播放脚本素材」共用。
 * 单独提出来是为了两处 schema 不各写一遍，避免以后改参数漏改一处。
 */
/** 播放的公共参数（不含轴，轴的来源两个方法不同）。 */
function scriptPlaybackCommonFields() {
  return {
    loop: { type: "boolean" as const, label: "循环播放", default: false },
    startMs: {
      type: "number" as const,
      label: "起始时间（毫秒）",
      min: 0,
      max: 3600000,
      step: 100,
      default: 0,
    },
    invert: {
      type: "boolean" as const,
      label: "输出反相",
      default: false,
      description: "安装方向相反时打开：0 与 1 对调。",
    },
    interpolation: {
      type: "enum" as const,
      label: "插值方式",
      options: [
        { value: "auto", label: "跟随设置" },
        { value: "pchip", label: "Pchip（平滑、不过冲）" },
        { value: "makima", label: "Makima（更平滑、可轻微过冲）" },
        { value: "linear", label: "线性（最贴原始点）" },
        { value: "step", label: "阶梯（保持到下一个点）" },
      ],
      default: "auto",
      description: "动作点之间的补间算法，与 MultiFunPlayer 的插值选项一一对应。",
    },
  };
}

interface GroupPlaybackParams {
  loop: boolean;
  startMs: number;
  invert: boolean;
  interpolation: string;
}

const SERIAL_PICKER_ID = "osr6-serial-picker";

function connectionKey(config: Osr6Settings): string {
  return JSON.stringify([config.transport, config.udpHost, config.udpPort, config.serialKind, config.serialBackend,
    config.serialVendorId, config.serialProductId, config.serialPortIndex, config.baudRate]);
}

function serialOptions(config: Osr6Settings): SerialOptions {
  return {
    baudRate: config.baudRate, kind: config.serialKind,
    vendorId: config.serialKind === "bluetooth" ? undefined : parseUsbId(config.serialVendorId),
    productId: config.serialKind === "bluetooth" ? undefined : parseUsbId(config.serialProductId),
  };
}

function nativeSerialApi(ctx: ExtensionContext): NativeSerialApi {
  const runtime = getRuntime(ctx);
  if (!runtime.nativeSerial) {
    runtime.nativeSerial = new NativeSerialApi(() => {
      try {
        return loadSerialPort({
          process: ctx.native.node.require<SerialportNodeModules["process"]>("node:process"),
          buffer: ctx.native.node.require<SerialportNodeModules["buffer"]>("node:buffer"),
          fs: ctx.native.node.require<SerialportNodeModules["fs"]>("node:fs"),
          os: ctx.native.node.require<SerialportNodeModules["os"]>("node:os"),
          path: ctx.native.node.require<SerialportNodeModules["path"]>("node:path"),
          crypto: ctx.native.node.require<SerialportNodeModules["crypto"]>("node:crypto"),
          zlib: ctx.native.node.require<SerialportNodeModules["zlib"]>("node:zlib"),
          stream: ctx.native.node.require<SerialportNodeModules["stream"]>("node:stream"),
          events: ctx.native.node.require<SerialportNodeModules["events"]>("node:events"),
          util: ctx.native.node.require<SerialportNodeModules["util"]>("node:util"),
          tty: ctx.native.node.require<SerialportNodeModules["tty"]>("node:tty"),
          child_process: ctx.native.node.require<SerialportNodeModules["child_process"]>("node:child_process"),
        });
      } catch (error) {
        throw new Error("桌面原生串口不可用：" + errorMessage(error) + "。此通道需要桌面宿主开放 Node 原生能力，网页版请使用浏览器授权。");
      }
    });
  }
  return runtime.nativeSerial;
}

/** 所有连接入口共用；自动连接只复用授权，绝不弹设备授权窗口。 */
async function reconnectNow(ctx: ExtensionContext): Promise<string> {
  const runtime = getRuntime(ctx);
  if (runtime.signal.aborted) throw new Error("运行已结束，连接已取消。");
  runtime.stopPlaybacks();
  runtime.clearTestTimers();
  const config = readSettings(ctx);
  runtime.connectionKey = connectionKey(config);
  await runtime.engine.connect(config, {
    loadDgram: () => ctx.native.node.require("node:dgram"),
    selectedPort: config.transport === "serial" ? runtime.selectedPort : undefined,
    serialApi: config.transport === "serial" && config.serialBackend === "native" ? nativeSerialApi(ctx) : undefined,
    signal: runtime.signal,
  });
  return runtime.engine.endpoint ?? "";
}

async function connectFromUser(ctx: ExtensionContext): Promise<string> {
  try {
    return await reconnectNow(ctx);
  } catch (error) {
    if (error instanceof SerialSelectionRequiredError && !getRuntime(ctx).signal.aborted) {
      await showSerialPicker(ctx);
      return getRuntime(ctx).engine.endpoint ?? error.message;
    }
    throw error;
  }
}

async function showSerialPicker(ctx: ExtensionContext): Promise<void> {
  const runtime = getRuntime(ctx);
  runtime.stopPlaybacks();
  runtime.clearTestTimers();
  runtime.engine.stop();
  await ctx.ui.show(SERIAL_PICKER_ID, {}, { modal: true });
}

function startRuntime(ctx: ExtensionContext): void {
  const runtime = getRuntime(ctx);
  if (runtime.started || runtime.signal.aborted) return;
  runtime.started = true;
  const initial = readSettings(ctx);
  if (readDeviceHost(ctx).length === 0) ctx.variables.set(DEVICE_HOST_VARIABLE, initial.udpHost);
  if (readDevicePort(ctx) === 0) ctx.variables.set(DEVICE_PORT_VARIABLE, initial.udpPort);
  if (readDeviceTransport(ctx) === "") ctx.variables.set(DEVICE_TRANSPORT_VARIABLE, initial.transport);
  runtime.connectionKey = connectionKey(readSettings(ctx));
  if (!runtime.engine.connected && readRaw(ctx, "autoConnect") !== false) {
    void reconnectNow(ctx).catch((error: unknown) => {
      if (!runtime.signal.aborted) console.log("[osr6] auto-connect: " + errorMessage(error));
    });
  }
  runtime.deviceWatch = setInterval(() => {
    const next = connectionKey(readSettings(ctx));
    if (next === runtime.connectionKey) return;
    // 序号或筛选变化后丢弃旧对象，要求唯一候选或重新选择。
    runtime.selectedPort = undefined;
    void reconnectNow(ctx).catch((error: unknown) => {
      if (!runtime.signal.aborted) console.log("[osr6] reconnect: " + errorMessage(error));
    });
  }, 2000);
}
@extension({ id: "osr6", label: "OSR6 联动" })
class Osr6Extension extends Extension {
  static settings = settings((s) => ({
    transport: s
      .enum("连接方式", ["udp", "serial"] as const)
      .labels({ udp: "WiFi / UDP", serial: "USB / 蓝牙串口" })
      .default("udp")
      .describe(
        "UDP 仅桌面宿主可直连；USB 和传统蓝牙 SPP 支持桌面原生串口或网页浏览器授权。BLE 不属于串口。",
      ),
    serialKind: s
      .enum("串口类型", ["auto", "usb", "bluetooth"] as const)
      .labels({ auto: "自动识别", usb: "USB", bluetooth: "传统蓝牙 SPP" })
      .default("auto")
      .describe("蓝牙需先在系统里配对；不支持仅提供 BLE 的设备。玩家可在设备选择面板覆盖。")
      .enabledWhen("transport", "serial"),
    serialBackend: s
      .enum("串口访问方式", ["web", "native", "windows"] as const)
      .labels({ web: "浏览器授权", native: "桌面原生串口", windows: "桌面原生串口（旧设置）" })
      .default("web")
      .describe("桌面原生串口使用 serialport，支持 Windows、macOS、Linux 的系统串口；网页版使用浏览器授权。旧 windows 设置自动兼容。")
      .enabledWhen("transport", "serial"),
    udpHost: s
      .string("设备 IPv4 地址")
      .default("192.168.1.1")
      .describe("OSR6/SR6 在 WiFi 模式下显示的本机地址，可在设备屏幕或路由器后台查到。")
      .enabledWhen("transport", "udp"),
    udpPort: s
      .number("UDP 端口")
      .default(8000)
      .range(1, 65535)
      .describe("TCode over UDP 的默认端口是 8000。")
      .enabledWhen("transport", "udp"),
    serialVendorId: s
      .string("串口 USB 厂商 ID（可选）")
      .default("")
      .describe("形如 0x1a86 或 6790。仅筛选 USB；蓝牙模式忽略。多个候选必须由玩家选择。")
      .enabledWhen("transport", "serial"),
    serialProductId: s
      .string("串口 USB 产品 ID（可选）")
      .default("")
      .enabledWhen("transport", "serial"),
    serialPortIndex: s
      .number("串口序号")
      .default(0)
      .range(0, 9)
      .describe(
        "已授权完整列表的序号（从 0 开始），用于编辑器测试与兼容旧配置；游戏中多个候选必须手动选设备。",
      )
      .enabledWhen("transport", "serial"),
    baudRate: s
      .number("串口波特率")
      .default(115200)
      .range(1200, 921600)
      .enabledWhen("transport", "serial"),
    updateHz: s
      .number("发送频率（Hz）")
      .default(30)
      .range(1, 60)
      .describe("每秒发送位置帧的次数。30Hz 足够流畅；串口带宽紧张时可降到 20。"),
    smoothing: s
      .number("平滑系数")
      .default(0.35)
      .range(0, 0.95)
      .step(0.05)
      .describe("0 表示直接跳到目标值；越大越慢越柔。相当于逐帧向目标值逼近的比例。"),
    idleStopMs: s
      .number("自动停机（毫秒）")
      .default(0)
      .range(0, 600000)
      .describe("超过这个时间没有新指令就发送 DSTOP 停机。0 表示不自动停机。"),
    axes: s
      .array("轴配置", (item) => ({
        axis: item.enum("轴", TCODE_AXES),
        enabled: item.boolean("启用").default(true),
        invert: item.boolean("反相").default(false),
      }))
      .maxItems(TCODE_AXES.length)
      .itemDefault({ axis: "L0", enabled: true, invert: false })
      .addLabel("添加轴")
      .emptyHint("未配置时默认驱动 L0/L1/L2/R0/R1/R2 六个轴")
      .describe("只驱动这里启用的轴；留空则默认使用线性三轴 + 旋转三轴。"),
    scriptAxis: s
      .enum("脚本默认轴", TCODE_AXES)
      .default("L0")
      .describe("funscript 播放在没有单独指定轴时驱动哪个轴。"),
    playbackHz: s
      .number("脚本采样频率（Hz）")
      .default(100)
      .range(10, 120)
      .describe("funscript 采样并下发的频率。100Hz 与 MultiFunPlayer 的 10ms 更新间隔一致；串口带宽紧张时可降到 50。"),
    scriptInterpolation: s
      .enum("插值方式", ["pchip", "makima", "linear", "step"] as const)
      .labels({
        pchip: "Pchip（平滑、不过冲）",
        makima: "Makima（更平滑、可轻微过冲）",
        linear: "线性（最贴原始点）",
        step: "阶梯（保持到下一个点）",
      })
      .default("pchip")
      .describe(
        "动作点之间的补间算法，与 MultiFunPlayer 的插值选项一致。Pchip 是它的默认值，也最接近手写脚本的原始节奏。",
      ),
    scriptImportFolder: s
      .string("脚本素材导入目录")
      .default("bgm")
      .describe(
        "编辑器里的「导入 funscript」把生成的 WAV 写到 assets/ 下这个子目录（例如 bgm、se）。只填相对路径。",
      ),
    scriptImportOverwrite: s
      .boolean("导入时覆盖同名文件")
      .default(false)
      .describe("关闭时遇到同名文件会自动加 -2、-3 后缀，不会覆盖已有素材。"),
    autoConnect: s
      .boolean("启动时自动连接")
      .default(true)
      .describe(
        "启动时尝试连接一次。串口仅在候选唯一且已授权时自动连接；首次授权和多设备选择请点击「选择串口设备」。",
      ),
  }));

  /**
   * 引擎启动时（含预览重载）做三件事：回填变量、自动连接、开始监听设备设置。
   *
   * 注意：扩展没有实现 render()（玩家界面是引擎托管的 UI 文档），宿主**不会**
   * 创建扩展实例，因此 onInit 不会被调用 —— 运行时初始化只能放在这个静态钩子里。
   * `startRuntime` 内部有幂等保护，重复调用无副作用。
   */
  static async onRegister(ctx: ExtensionContext) {
    void startRuntime(ctx);
  }

  /** 实例生命周期：某些宿主路径会调用，和 onRegister 共用同一套幂等初始化。 */
  async onInit(): Promise<void> {
    void startRuntime(this.context);
  }

  static setTransport = this.method({
    title: "设置连接方式",
    description:
      "玩家选择 WiFi（UDP）或 USB / 传统蓝牙串口；串口打开设备选择面板。",
    returns: { type: "string", label: "当前连接" },
    schema: {
      mode: {
        type: "enum",
        label: "连接方式",
        options: [
          { value: "udp", label: "WiFi / UDP" },
          { value: "serial", label: "USB / 蓝牙串口" },
        ],
        default: "udp",
      },
    },
    async run(ctx, params) {
      const mode = params.mode === "serial" ? "serial" : "udp";
      ctx.variables.set(DEVICE_TRANSPORT_VARIABLE, mode);
      const label = mode === "serial" ? "USB / 蓝牙串口" : "WiFi / UDP";
      if (mode === "serial") {
        const runtime = getRuntime(ctx);
        runtime.connectionKey = connectionKey(readSettings(ctx));
        runtime.stopPlaybacks();
        runtime.clearTestTimers();
        await runtime.engine.disconnect();
        await showSerialPicker(ctx);
        return "请选择 USB 或传统蓝牙串口设备。";
      }
      try {
        const endpoint = await connectFromUser(ctx);
        console.log("[osr6] transport=" + mode + " endpoint=" + endpoint);
        return label + "：" + endpoint;
      } catch (error) {
        // 连不上（例如当前环境拿不到串口授权）也要保留玩家的选择，
        // 让设置界面停在对应页签，而不是整个调用失败。
        const reason = error instanceof Error ? error.message : String(error);
        console.log("[osr6] transport=" + mode + " connect failed: " + reason);
        return label + "：连接失败（" + reason + "）";
      }
    },
  });

  static chooseSerialDevice = this.method({
    title: "选择串口设备",
    description: "打开 USB / 传统蓝牙 SPP 设备选择面板，适用于桌面和支持 Web Serial 的安全网页。",
    async run(ctx) {
      await showSerialPicker(ctx);
    },
  });

  static setDeviceAddress = this.method({
    title: "设置设备地址",
    description: "把设备地址/端口写进玩家档案并立即重连。适合剧本或自定义界面直接调用。",
    returns: { type: "string", label: "当前连接" },
    schema: {
      host: {
        type: "string",
        label: "设备地址",
        required: true,
        description: "例如 192.168.1.1。",
      },
      port: {
        type: "number",
        label: "端口",
        min: 1,
        max: 65535,
        step: 1,
        default: 8000,
      },
    },
    async run(ctx, params) {
      const host = String(params.host ?? "").trim();
      if (host.length === 0) {
        throw new Error("设备地址不能为空。");
      }
      const port = Math.round(params.port ?? 8000);
      ctx.variables.set(DEVICE_HOST_VARIABLE, host);
      ctx.variables.set(DEVICE_PORT_VARIABLE, String(port));
      const endpoint = await connectFromUser(ctx);
      console.log("[osr6] device " + host + ":" + port + " endpoint=" + endpoint);
      return endpoint;
    },
  });
  static connect = this.method({
    title: "连接 OSR6",
    description: "按项目设置打开 UDP 或串口连接，并启动发送循环。",
    returns: { type: "string", label: "连接端点" },
    async run(ctx) {
      const target = getRuntime(ctx).engine;
      const config = readSettings(ctx);
      const endpoint = await connectFromUser(ctx);
      if (target.connected) console.log("[osr6] connected " + target.endpoint + " via " + config.transport);
      return endpoint;
    },
  });

  static testDevice = this.method({
    title: "测试设备连接",
    description:
      "按当前设置连接，并让设备做一次小幅动作（中位 → 68% → 中位）。串口未授权时先打开选择面板。",
    returns: { type: "string", label: "测试结果" },
    async run(ctx) {
      const runtime = getRuntime(ctx);
      const target = runtime.engine;
      const endpoint = await connectFromUser(ctx);
      if (!target.connected) return endpoint;

      // 三个动作必须错开发：同一 tick 里连着发，后一条会直接覆盖前一条的
      // 目标值（第一条的爬升还没开始就被换掉），设备看起来完全没动。
      target.setAxisExact("L0", 0.5);
      for (const [ms, value] of [[150, 0.68], [750, 0.5]]) {
        const timer = setTimeout(() => {
          runtime.testTimers.delete(timer);
          if (target.connected && !runtime.signal.aborted) target.setAxis("L0", value, 350);
        }, ms);
        runtime.testTimers.add(timer);
      }

      console.log("[osr6] test-device " + (target.endpoint ?? "?"));
      return "已连接并发送测试动作：" + (target.endpoint ?? "");
    },
  });
  static disconnect = this.method({
    title: "断开 OSR6",
    description: "先停止脚本播放并发送 DSTOP，再关闭传输通道。",
    async run(ctx) {
      const runtime = getRuntime(ctx);
      runtime.stopPlaybacks();
      runtime.clearTestTimers();
      await runtime.engine.disconnect();
    },
  });

  static stop = this.method({
    title: "急停",
    description: "立即停止脚本播放并发送 DSTOP，之后不再发送位置帧。",
    run(ctx) {
      const runtime = getRuntime(ctx);
      runtime.stopPlaybacks();
      runtime.clearTestTimers();
      runtime.engine.stop();
    },
  });

  static recenter = this.method({
    title: "回到中位",
    description: "线性/旋转轴回到 0.5，振动与辅助轴回到 0。",
    run(ctx) {
      getRuntime(ctx).engine.recenter();
    },
  });

  static setAxis = this.method({
    title: "设置轴位置",
    description: "把某个轴设到 0-1 的位置，引擎会在下一帧发出。",
    schema: {
      axis: {
        type: "enum",
        label: "轴",
        options: AXIS_OPTIONS,
        default: "L0",
      },
      value: {
        type: "number",
        label: "目标位置",
        min: 0,
        max: 1,
        step: 0.01,
        default: 0.5,
      },
      rampMs: {
        type: "number",
        label: "爬升时间（毫秒）",
        min: 0,
        max: 10000,
        step: 50,
        default: 0,
        description: "大于 0 时由设备自己做时间插值，适合单次平滑移动。",
      },
    },
    run(ctx, params) {
      const axis: TCodeAxis = isTCodeAxis(params.axis) ? params.axis : "L0";
      getRuntime(ctx).engine.setAxis(axis, params.value, params.rampMs);
    },
  });

  static status = this.method({
    title: "读取连接状态",
    description: "返回连接状态、端点、各轴目标值和已发送帧数的 JSON。",
    returns: { type: "string", label: "状态 JSON" },
    run(ctx) {
      return JSON.stringify(getRuntime(ctx).engine.snapshot());
    },
  });

  static parseScript = this.method({
    hidden: true,
    title: "解析 funscript",
    description:
      "只解析不播放：按指针取到脚本，返回动作点数、时长和警告。不接设备也能用来检查脚本是否可用。",
    returns: { type: "string", label: "解析摘要" },
    schema: {
      ref: {
        type: "string",
        label: "脚本指针",
        required: true,
        description:
          "`asset:se/xxx.wav`（WAV 载波）、`var:变量名` 或 `global:键名`；以 { 或 [ 开头时按内联 JSON 处理。",
      },
    },
    async run(ctx, params) {
      const loaded = await loadScript(params.ref, scriptSources(ctx));
      const warnings =
        loaded.script.warnings.length > 0
          ? `警告：${loaded.script.warnings.join("；")}`
          : "无警告";
      return `${describeFunscript(loaded.script)}（来源 ${loaded.source}）。${warnings}`;
    },
  });

  static playScript = this.method({
    title: "播放脚本",
    description:
      "同时播放一组脚本，每个轴一条（只有一条时就是长度 1 的组）。素材是 WAV 载波，需先导入 assets/se 并强制打包。",
    returns: { type: "string", label: "播放摘要" },
    schema: {
      scripts: {
        type: "list",
        label: "脚本",
        required: true,
        minItems: 1,
        maxItems: 6,
        item: {
          axis: { type: "enum", label: "轴", options: AXIS_OPTIONS, default: "L0" },
          asset: { type: "asset", label: "脚本素材", assetType: "audio" },
        },
      },
      ...scriptPlaybackCommonFields(),
    },
    async run(ctx, params) {
      const signal = ctx.flow.signal;
      const runtime = getRuntime(ctx);
      const request = runtime.beginPlaybackRequest();
      const check = () => {
        if (request.aborted || signal.aborted || ctx.flow.signal !== signal) throw new Error("脚本播放已取消。");
      };
      try {
        check();
        const rows = params.scripts ?? [];
        if (rows.length === 0) {
          throw new Error("脚本组为空：至少添加一条。");
        }

        const items: GroupItem[] = [];
        for (const row of rows) {
          if (!row.asset) {
            throw new Error("有一条脚本没有选择素材。");
          }
          const text = await scriptSources(ctx, request).readAsset?.(row.asset);
          check();
          if (text === undefined) {
            throw new Error("当前宿主没有提供素材读取能力。");
          }
          const script = parseFunscript(text);
          const axis: TCodeAxis = isTCodeAxis(row.axis) ? row.axis : "L0";
          console.log(
            "[osr6] asset " + row.asset + " -> " + script.actions.length + " actions / " +
              script.durationMs + "ms",
          );
          items.push({ axis, script, label: row.asset });
        }

        check();
        runtime.finishPlaybackRequest(request);
        return startGroup(ctx, items, params, "");
      } catch (error) {
        check();
        throw error;
      } finally {
        runtime.finishPlaybackRequest(request);
      }
    },
  });

  static setSpeed = this.method({
    title: "设置播放速度",
    description:
      "设置脚本播放倍速（0.1–4）。播放中立即生效且不跳进度；当前没在播放时记下来，下一次播放沿用。",
    returns: { type: "string", label: "当前倍速" },
    schema: {
      speed: {
        type: "number",
        label: "倍速",
        min: 0.1,
        max: 4,
        step: 0.1,
        default: 1,
        description: "1 = 原速，2 = 两倍速，0.5 = 半速。",
      },
    },
    run(ctx, params) {
      const raw = Number(params.speed);
      const next = Math.min(4, Math.max(0.1, Number.isFinite(raw) ? raw : 1));
      const runtime = getRuntime(ctx);
      runtime.playbackSpeed = next;
      const activePlaybacks = runtime.activePlaybacks;
      for (const item of activePlaybacks) item.player.setSpeed(next);
      console.log(
        "[osr6] speed " + next + (activePlaybacks.length > 0 ? " (applied to " + activePlaybacks.length + ")" : " (stored)"),
      );
      return next.toFixed(1) + "x";
    },
  });

  static setStrength = this.method({
    title: "设置强度范围",
    description:
      "按轴设置脚本强度的上下限（0–100%）。播放中立即生效且不跳进度；没在播放时记下来，之后的播放沿用。上下限填 0 / 100 即恢复原样。",
    returns: { type: "string", label: "设置结果" },
    schema: {
      ranges: {
        type: "list",
        label: "强度范围",
        required: true,
        minItems: 1,
        maxItems: 12,
        item: {
          axis: { type: "enum", label: "轴", options: AXIS_OPTIONS, default: "L0" },
          min: {
            type: "number",
            label: "强度下限（%）",
            min: 0,
            max: 100,
            step: 1,
            default: 0,
            description: "脚本值 0 映射到这里。",
          },
          max: {
            type: "number",
            label: "强度上限（%）",
            min: 0,
            max: 100,
            step: 1,
            default: 100,
            description: "脚本值 1 映射到这里。上下限相同表示整段恒定。",
          },
        },
      },
    },
    run(ctx, params) {
      const { strengthRanges, activePlaybacks } = getRuntime(ctx);
      const rows = params.ranges ?? [];
      if (rows.length === 0) {
        throw new Error("强度范围为空：至少添加一行。");
      }
      const applied: string[] = [];
      const changed = new Set<TCodeAxis>();
      for (const row of rows) {
        const axis: TCodeAxis = isTCodeAxis(row.axis) ? row.axis : "L0";
        const min = percentToFraction(row.min, 0);
        const max = percentToFraction(row.max, 100);
        strengthRanges.set(axis, { min, max });
        changed.add(axis);
        applied.push(axis + " " + Math.round(min * 100) + "–" + Math.round(max * 100) + "%");
      }
      for (const item of activePlaybacks) {
        if (changed.has(item.axis)) item.player.refreshOutput();
      }
      console.log("[osr6] strength " + applied.join(", "));
      return "已设置：" + applied.join("，");
    },
  });

  static pauseScript = this.method({
    title: "暂停脚本",
    description: "暂停整组脚本，设备停在当前位置。",
    run(ctx) {
      const { activePlaybacks } = getRuntime(ctx);
      for (const item of activePlaybacks) item.player.pause();
    },
  });

  static resumeScript = this.method({
    title: "继续脚本",
    description: "从暂停处继续整组脚本。",
    run(ctx) {
      const { activePlaybacks } = getRuntime(ctx);
      const hz = readNumber(ctx, "playbackHz", 100, 10, 120);
      for (const item of activePlaybacks) item.player.resume(hz);
    },
  });

  static seekScript = this.method({
    title: "跳转脚本",
    description: "把整组脚本的播放位置跳到指定毫秒。暂停状态下只更新位置。",
    returns: { type: "string", label: "跳转结果" },
    schema: {
      ms: {
        type: "number",
        label: "时间（毫秒）",
        min: 0,
        max: 3600000,
        step: 100,
        default: 0,
      },
    },
    run(ctx, params) {
      const { activePlaybacks } = getRuntime(ctx);
      if (activePlaybacks.length === 0) return "当前没有在播放";
      let resolved = 0;
      for (const item of activePlaybacks) resolved = item.player.seek(params.ms);
      return `已跳到 ${Math.round(resolved)}ms（${activePlaybacks.length} 条脚本）`;
    },
  });

  static stopScript = this.method({
    title: "停止脚本",
    description: "停止整组脚本并回到中位。",
    run(ctx) {
      const runtime = getRuntime(ctx);
      runtime.stopPlaybacks();
      runtime.engine.recenter();
    },
  });

  static scriptStatus = this.method({
    title: "读取脚本播放状态",
    description: "返回每条脚本的轴、进度、循环与已下发帧数的 JSON。",
    returns: { type: "string", label: "状态 JSON" },
    run(ctx) {
      const { engine, activePlaybacks } = getRuntime(ctx);
      return JSON.stringify({
        device: engine.connected,
        playing: activePlaybacks.length,
        playbacks: activePlaybacks.map((item) => ({ ...item.player.state(), axis: item.axis })),
      });
    },
  });
}

export default Osr6Extension;

@extension({ id: SERIAL_PICKER_ID, label: "串口设备选择", hidden: true })
export class SerialDevicePickerExtension extends Extension<SerialDevicePickerProps> {
  render() {
    const ctx = this.context;
    const runtime = getRuntime(ctx);
    return {
      component: SerialDevicePicker,
      props: {
        signal: runtime.signal,
        initialBackend: readSettings(ctx).serialBackend,
        getOptions: (backend?: SerialBackend) => ({
          ...serialOptions(readSettings(ctx)),
          api: backend === "native" ? nativeSerialApi(ctx) : undefined,
        }),
        snapshot: () => runtime.engine.snapshot(),
        connect: async (port, kind, baudRate, backend = readSettings(ctx).serialBackend) => {
          if (runtime.signal.aborted) throw new Error("运行已结束。");
          if (!Number.isInteger(baudRate) || baudRate < 1200 || baudRate > 921600) throw new Error("波特率必须是 1200–921600 之间的整数。");
          ctx.variables.set(DEVICE_TRANSPORT_VARIABLE, "serial");
          ctx.variables.set("OSR6串口类型", kind);
          ctx.variables.set("OSR6波特率", String(baudRate));
          ctx.variables.set("OSR6串口访问方式", backend ?? "web");
          runtime.selectedPort = port;
          await reconnectNow(ctx);
        },
        disconnect: async () => {
          runtime.stopPlaybacks(); runtime.clearTestTimers();
          await runtime.engine.disconnect();
        },
        stop: () => { runtime.stopPlaybacks(); runtime.clearTestTimers(); runtime.engine.stop(); },
        close: async () => { await ctx.ui.hide(SERIAL_PICKER_ID); },
      } satisfies SerialDevicePickerProps,
    };
  }
}
