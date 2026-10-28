import { Extension, extension, settings, type ExtensionContext } from "@avg-studio/sdk";
import { decodeCarrierWav } from "./carrier";
import { Osr6Engine, type Osr6AxisSetting, type Osr6Settings } from "./engine";
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
let boundSignal: AbortSignal | null = null;

function bindRunLifecycle(ctx: { flow?: { signal?: AbortSignal } }): void {
  const signal = ctx.flow?.signal;
  if (!signal || signal === boundSignal) return;

  if (boundSignal) {
    // 旧信号不用手动解绑：它已经被取消，回调也不会再触发
    boundSignal = null;
  }

  boundSignal = signal;
  signal.addEventListener("abort", () => {
    const wasPlaying = activePlaybacks.length > 0;
    stopPlaybacks();
    if (deviceWatch !== null) {
      clearInterval(deviceWatch);
      deviceWatch = null;
    }
    runtimeStarted = false;
    getEngine().stop();
    if (wasPlaying) {
      console.log("[osr6] run aborted (left preview / reset), playback stopped");
    }
  });
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
const strengthRanges = new Map<TCodeAxis, { min: number; max: number }>();

function strengthFor(axis: TCodeAxis): { min: number; max: number } {
  return strengthRanges.get(axis) ?? { min: 0, max: 1 };
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
function startPlaybackWatchdog(): void {
  if (playbackHeartbeat !== null) clearInterval(playbackHeartbeat);
  playbackHeartbeat = setInterval(() => {
    if (activePlaybacks.length === 0) {
      stopPlaybacks();
      return;
    }
    if (activePlaybacks.every((item) => !item.player.state().active)) {
      stopPlaybacks();
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
  const target = getEngine();
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

  bindRunLifecycle(ctx);

  const interpolation = resolveInterpolation(ctx, params.interpolation);
  const hz = readNumber(ctx, "playbackHz", 100, 10, 120);

  stopPlaybacks();
  for (const item of items) {
    const player = new FunscriptPlayer();
    player.play(
      item.script,
      {
        axis: item.axis,
        loop: params.loop,
        speed: playbackSpeed,
        startMs: params.startMs,
        invert: params.invert,
        interpolation,
      },
      // 强度重映射：每帧按该轴当前的范围取值，所以播放中改强度也会立即生效。
      (sinkAxis, value) => {
        const range = strengthFor(sinkAxis);
        target.setAxisExact(sinkAxis, range.min + (range.max - range.min) * value);
      },
      hz,
    );
    activePlaybacks.push({ axis: item.axis, player, label: item.label });
  }

  startPlaybackWatchdog();
  console.log(
    "[osr6] play group [" + activePlaybacks.map((item) => item.axis).join(",") + "] hz=" + hz,
  );

  const summary = items
    .map((item) => {
      const range = strengthFor(item.axis);
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

/**
 * 设备引擎只应该有一份：物理设备只有一台，两个连接会互相抢控制权。
 * SDK 也要求状态不能挂在实例上（方法每次调用拿到的实例不共享字段），
 * 所以放在模块作用域。
 */
let engine: Osr6Engine | null = null;

function getEngine(): Osr6Engine {
  if (!engine) engine = new Osr6Engine();
  return engine;
}

/**
 * 当前正在播放的脚本组：每个轴一个播放器，同时开播。
 *
 * 之前是单播放器（一次只能驱动一个轴），现在改成组：单脚本就是长度 1 的数组。
 * 组内的播放器共享开始时刻，各自把自己的位置写到自己那个轴上。
 */
interface ActivePlayback {
  axis: TCodeAxis;
  player: FunscriptPlayer;
  label: string;
}

let activePlaybacks: ActivePlayback[] = [];

/** 全局播放倍速：由「设置播放速度」改，播放中立即生效并延续到之后的播放。 */
let playbackSpeed = 1;

/** 监听玩家改设备地址/端口：变了就用新地址重连。 */
let deviceWatch: ReturnType<typeof setInterval> | null = null;

/** 播放心跳（每 2 秒打一条日志，用于判断播放循环有没有被打断）。 */
let playbackHeartbeat: ReturnType<typeof setInterval> | null = null;

function stopPlaybacks(): void {
  for (const item of activePlaybacks) {
    item.player.stop();
  }
  activePlaybacks = [];
  if (playbackHeartbeat !== null) {
    clearInterval(playbackHeartbeat);
    playbackHeartbeat = null;
  }
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
}): ScriptSources {
  return {
    async readAsset(ref: string): Promise<string> {
      const { url } = ctx.asset.resolve(ref);
      let response: Response;
      try {
        response = await fetch(url);
      } catch (error) {
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

/** 按当前设置重连一次，返回端点。玩家改完配置后调用。 */
async function reconnectNow(ctx: ExtensionContext): Promise<string> {
  const engine = getEngine();
  if (engine.connected) await engine.disconnect();
  const config = readSettings(ctx);
  await engine.connect(config, ctx.native.node.require("node:dgram"));
  return engine.endpoint ?? "";
}
/** 运行时是否已经初始化（幂等保护；运行周期结束时重置）。 */
let runtimeStarted = false;

/**
 * 运行时初始化：回填玩家变量、自动连接、开始监听设备设置变化。
 *
 * 必须能被重复调用而不产生副作用——宿主可能在 onRegister / onInit 之间
 * 只调用其中一个，而运行周期重置后又要重新初始化。
 */
function startRuntime(ctx: ExtensionContext): void {
  if (runtimeStarted) return;
  runtimeStarted = true;
  console.log("[osr6] runtime start");

  // 把实际生效的地址/端口回填进变量，设置界面才不会显示空白。
  const initial = readSettings(ctx);
  if (readDeviceHost(ctx).length === 0) {
    ctx.variables.set(DEVICE_HOST_VARIABLE, initial.udpHost);
  }
  if (readDevicePort(ctx) === 0) {
    ctx.variables.set(DEVICE_PORT_VARIABLE, initial.udpPort);
  }

  const target = getEngine();
  if (!target.connected && readRaw(ctx, "autoConnect") !== false) {
    void target
      .connect(readSettings(ctx), ctx.native.node.require("node:dgram"))
      .then(() => console.log("[osr6] auto-connected " + (target.endpoint ?? "?")))
      .catch((error) =>
        console.log(
          "[osr6] auto-connect failed: " +
            (error instanceof Error ? error.message : String(error)),
        ),
      );
  }

  // 玩家在设置界面改完地址/方式后，界面只写变量；这里轮询发现变化并重连。
  let lastHost = readDeviceHost(ctx);
  let lastPort = readDevicePort(ctx);
  let lastTransport = readDeviceTransport(ctx);
  if (deviceWatch !== null) clearInterval(deviceWatch);
  deviceWatch = setInterval(() => {
    const host = readDeviceHost(ctx);
    const port = readDevicePort(ctx);
    const transport = readDeviceTransport(ctx);
    if (host === lastHost && port === lastPort && transport === lastTransport) return;
    lastHost = host;
    lastPort = port;
    lastTransport = transport;
    const mode = readSettings(ctx).transport;
    if (mode === "udp" && host.length === 0) return;
    void (async () => {
      try {
        const engine = getEngine();
        if (engine.connected) await engine.disconnect();
        await engine.connect(readSettings(ctx), ctx.native.node.require("node:dgram"));
        console.log("[osr6] reconnected to " + (engine.endpoint ?? "?"));
      } catch (error) {
        console.log(
          "[osr6] reconnect failed: " +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    })();
  }, 2000);
}
@extension({ id: "osr6", label: "OSR6 联动" })
class Osr6Extension extends Extension {
  static settings = settings((s) => ({
    transport: s
      .enum("连接方式", ["udp", "serial"] as const)
      .labels({ udp: "WiFi / UDP", serial: "USB 串口" })
      .default("udp")
      .describe(
        "UDP：设备连上同一个 WiFi 后监听端口。串口：USB 直连，走 Web Serial，需要宿主允许访问串口。",
      ),
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
      .describe("形如 0x1a86 或 6790。留空则使用已授权端口，或让你在弹窗里选择。")
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
        "已授权串口列表里的第几个（从 0 开始）。编辑器「设备」面板会列出这个列表，点一下即可写入。",
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
        "引擎启动（含预览重载）时自动按上面的配置连一次设备；关掉就只能靠剧本里的「连接 OSR6」。",
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
    bindRunLifecycle(ctx);
    void startRuntime(ctx);
  }

  /** 实例生命周期：某些宿主路径会调用，和 onRegister 共用同一套幂等初始化。 */
  async onInit(): Promise<void> {
    void startRuntime(this.context);
  }

  static setTransport = this.method({
    title: "设置连接方式",
    description:
      "玩家选择用 WiFi（UDP）还是 USB 串口连接。写入玩家档案并立即用新方式重连。",
    returns: { type: "string", label: "当前连接" },
    schema: {
      mode: {
        type: "enum",
        label: "连接方式",
        options: [
          { value: "udp", label: "WiFi / UDP" },
          { value: "serial", label: "USB 串口" },
        ],
        default: "udp",
      },
    },
    async run(ctx, params) {
      const mode = params.mode === "serial" ? "serial" : "udp";
      ctx.variables.set(DEVICE_TRANSPORT_VARIABLE, mode);
      const label = mode === "serial" ? "USB 串口" : "WiFi / UDP";
      try {
        const endpoint = await reconnectNow(ctx);
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
      const endpoint = await reconnectNow(ctx);
      console.log("[osr6] device " + host + ":" + port + " endpoint=" + endpoint);
      return endpoint;
    },
  });
  static connect = this.method({
    title: "连接 OSR6",
    description: "按项目设置打开 UDP 或串口连接，并启动发送循环。",
    returns: { type: "string", label: "连接端点" },
    async run(ctx) {
      const target = getEngine();
      const config = readSettings(ctx);
      await target.connect(config, ctx.native.node.require("node:dgram"));
      console.log(
        "[osr6] connected " + (target.endpoint ?? "?") + " via " + config.transport,
      );
      return target.endpoint ?? "已连接";
    },
  });

  static testDevice = this.method({
    title: "测试设备连接",
    description:
      "按当前设置（含玩家改过的地址）连接一次，并让设备做一次小幅动作（中位 → 62% → 中位）。",
    returns: { type: "string", label: "测试结果" },
    async run(ctx) {
      const target = getEngine();
      if (target.connected) await target.disconnect();
      await target.connect(readSettings(ctx), ctx.native.node.require("node:dgram"));

      // 三个动作必须错开发：同一 tick 里连着发，后一条会直接覆盖前一条的
      // 目标值（第一条的爬升还没开始就被换掉），设备看起来完全没动。
      target.setAxisExact("L0", 0.5);
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      timers.push(setTimeout(() => target.setAxis("L0", 0.68, 350), 150));
      timers.push(setTimeout(() => target.setAxis("L0", 0.5, 350), 750));
      timers.push(
        setTimeout(() => {
          for (const timer of timers) clearTimeout(timer);
        }, 1500),
      );

      console.log("[osr6] test-device " + (target.endpoint ?? "?"));
      return "已连接并发送测试动作：" + (target.endpoint ?? "");
    },
  });
  static disconnect = this.method({
    title: "断开 OSR6",
    description: "先停止脚本播放并发送 DSTOP，再关闭传输通道。",
    async run() {
      stopPlaybacks();
      await getEngine().disconnect();
    },
  });

  static stop = this.method({
    title: "急停",
    description: "立即停止脚本播放并发送 DSTOP，之后不再发送位置帧。",
    run() {
      stopPlaybacks();
      getEngine().stop();
    },
  });

  static recenter = this.method({
    title: "回到中位",
    description: "线性/旋转轴回到 0.5，振动与辅助轴回到 0。",
    run() {
      getEngine().recenter();
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
    run(_ctx, params) {
      const axis: TCodeAxis = isTCodeAxis(params.axis) ? params.axis : "L0";
      getEngine().setAxis(axis, params.value, params.rampMs);
    },
  });

  static status = this.method({
    title: "读取连接状态",
    description: "返回连接状态、端点、各轴目标值和已发送帧数的 JSON。",
    returns: { type: "string", label: "状态 JSON" },
    run() {
      return JSON.stringify(getEngine().snapshot());
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
      const rows = params.scripts ?? [];
      if (rows.length === 0) {
        throw new Error("脚本组为空：至少添加一条。");
      }

      const items: GroupItem[] = [];
      for (const row of rows) {
        if (!row.asset) {
          throw new Error("有一条脚本没有选择素材。");
        }
        const text = await scriptSources(ctx).readAsset?.(row.asset);
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

      return startGroup(ctx, items, params, "");
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
    run(_ctx, params) {
      const raw = Number(params.speed);
      const next = Math.min(4, Math.max(0.1, Number.isFinite(raw) ? raw : 1));
      playbackSpeed = next;
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
    run(_ctx, params) {
      const rows = params.ranges ?? [];
      if (rows.length === 0) {
        throw new Error("强度范围为空：至少添加一行。");
      }
      const applied: string[] = [];
      for (const row of rows) {
        const axis: TCodeAxis = isTCodeAxis(row.axis) ? row.axis : "L0";
        const min = percentToFraction(row.min, 0);
        const max = percentToFraction(row.max, 100);
        strengthRanges.set(axis, { min, max });
        applied.push(axis + " " + Math.round(min * 100) + "–" + Math.round(max * 100) + "%");
      }
      console.log("[osr6] strength " + applied.join(", "));
      return "已设置：" + applied.join("，");
    },
  });

  static pauseScript = this.method({
    title: "暂停脚本",
    description: "暂停整组脚本，设备停在当前位置。",
    run() {
      for (const item of activePlaybacks) item.player.pause();
    },
  });

  static resumeScript = this.method({
    title: "继续脚本",
    description: "从暂停处继续整组脚本。",
    run(ctx) {
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
    run(_ctx, params) {
      if (activePlaybacks.length === 0) return "当前没有在播放";
      let resolved = 0;
      for (const item of activePlaybacks) resolved = item.player.seek(params.ms);
      return `已跳到 ${Math.round(resolved)}ms（${activePlaybacks.length} 条脚本）`;
    },
  });

  static stopScript = this.method({
    title: "停止脚本",
    description: "停止整组脚本并回到中位。",
    run() {
      stopPlaybacks();
      getEngine().recenter();
    },
  });

  static scriptStatus = this.method({
    title: "读取脚本播放状态",
    description: "返回每条脚本的轴、进度、循环与已下发帧数的 JSON。",
    returns: { type: "string", label: "状态 JSON" },
    run() {
      return JSON.stringify({
        device: getEngine().connected,
        playing: activePlaybacks.length,
        playbacks: activePlaybacks.map((item) => ({ ...item.player.state(), axis: item.axis })),
      });
    },
  });
}

export default Osr6Extension;
