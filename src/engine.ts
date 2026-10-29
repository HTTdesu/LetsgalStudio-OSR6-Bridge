/**
 * 设备引擎：维护目标值、做平滑、按固定频率把 TCode 帧发出去。
 *
 * 每个运行周期独立持有引擎；连接操作串行执行，物理串口由传输层仲裁。
 */

import {
  AXIS_NEUTRAL,
  clamp01,
  encodeAxis,
  encodeLine,
  isTCodeAxis,
  TCODE_AXES,
  TCODE_STOP,
  type TCodeAxis,
} from "./tcode";
import {
  createSerialTransport,
  createUdpTransport,
  parseUsbId,
  type SerialKind,
  type SerialBackend,
  type SerialApiLike,
  type SerialPortLike,
  type Transport,
} from "./transport";

export interface Osr6AxisSetting {
  axis: TCodeAxis;
  enabled: boolean;
  invert: boolean;
}

export interface Osr6Settings {
  transport: "udp" | "serial";
  serialKind?: SerialKind;
  serialBackend?: SerialBackend;
  udpHost: string;
  udpPort: number;
  serialVendorId: string;
  serialProductId: string;
  /** 已授权串口列表里的序号（0 起），对应编辑器里列出来的那一行。 */
  serialPortIndex: number;
  baudRate: number;
  updateHz: number;
  smoothing: number;
  idleStopMs: number;
  axes: Osr6AxisSetting[];
}

export interface ConnectionDependencies {
  serialApi?: SerialApiLike;
  /** 只有 UDP 分支才调用，网页版串口绝不会触碰 Node。 */
  loadDgram?: () => unknown;
  selectedPort?: SerialPortLike;
  signal?: AbortSignal;
}

export interface EngineSnapshot {
  connected: boolean;
  transport: "udp" | "serial" | null;
  endpoint: string | null;
  targets: Array<{ axis: TCodeAxis; value: number }>;
  lastError: string | null;
  sentFrames: number;
}

export class Osr6Engine {
  private transport: Transport | null = null;
  private settings: Osr6Settings | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private targets = new Map<TCodeAxis, number>();
  private current = new Map<TCodeAxis, number>();
  private lastSent = new Map<TCodeAxis, number>();
  private lastError: string | null = null;
  private sentFrames = 0;
  private lastCommandAt = 0;
  private stopped = false;
  private operations: Promise<void> = Promise.resolve();
  private revision = 0;

  constructor(private readonly onConnectionLost?: () => void) {}

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.operations.then(action);
    this.operations = result.catch(() => undefined);
    return result;
  }

  private connectionLost(transport: Transport, error: Error): void {
    if (this.transport !== transport) return;
    this.lastError = error.message;
    this.transport = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    this.onConnectionLost?.();
    void this.enqueue(() => transport.close()).catch(() => undefined);
  }

  get connected(): boolean {
    return this.transport !== null;
  }

  get endpoint(): string | null {
    return this.transport?.endpoint ?? null;
  }

  get errorText(): string | null {
    return this.lastError;
  }

  connect(
    settings: Osr6Settings,
    dependencies: ConnectionDependencies = {},
  ): Promise<void> {
    const revision = ++this.revision;
    return this.enqueue(async () => {
      await this.disconnectInternal();
      const cancelled = () => revision !== this.revision || dependencies.signal?.aborted;
      const check = () => { if (cancelled()) throw new Error("连接已取消。"); };
      check();
      this.lastError = null;
      let candidate: Transport | null = null;
      const onError = (error: Error) => { if (candidate) this.connectionLost(candidate, error); };
      try {
        if (settings.transport === "serial") {
          candidate = await createSerialTransport({
            api: dependencies.serialApi,
            baudRate: settings.baudRate,
            kind: settings.serialKind,
            vendorId: settings.serialKind === "bluetooth" ? undefined : parseUsbId(settings.serialVendorId),
            productId: settings.serialKind === "bluetooth" ? undefined : parseUsbId(settings.serialProductId),
            portIndex: settings.serialPortIndex,
            selectedPort: dependencies.selectedPort,
            onError,
          });
        } else {
          let dgram: unknown;
          try {
            dgram = dependencies.loadDgram?.();
            if (!dgram) throw new Error("宿主没有 Node UDP 能力");
          } catch {
            throw new Error("当前环境不能直接发送 UDP。网页版请使用 USB / 蓝牙串口；WiFi UDP 需要桌面宿主或另装桥接程序。");
          }
          candidate = createUdpTransport({
            host: settings.udpHost.trim(),
            port: settings.udpPort,
            dgram,
            onError,
          });
        }
        if (cancelled()) { await candidate.close(); check(); }
        this.transport = candidate;
        this.settings = settings;
        this.resetAxisState();
        // 连接成功本身不触发运动，等到第一条明确的位置命令再发送。
        this.stopped = true;
        const hz = Math.min(60, Math.max(1, settings.updateHz));
        this.timer = setInterval(() => this.tick(), Math.round(1000 / hz));
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    });
  }

  private resetAxisState(): void {
    this.targets.clear();
    this.current.clear();
    this.lastSent.clear();
    for (const axis of TCODE_AXES) {
      this.targets.set(axis, AXIS_NEUTRAL[axis]);
      this.current.set(axis, AXIS_NEUTRAL[axis]);
    }
  }

  private enabledAxes(): Osr6AxisSetting[] {
    const configured = this.settings?.axes ?? [];
    const usable = configured.filter((row) => isTCodeAxis(row.axis) && row.enabled);
    if (configured.length > 0) return usable;
    // 没配置就退回线性三轴 + 旋转三轴，保证开箱能出效果。
    return (["L0", "L1", "L2", "R0", "R1", "R2"] as TCodeAxis[]).map((axis) => ({
      axis,
      enabled: true,
      invert: false,
    }));
  }

  private tick(): void {
    const transport = this.transport;
    const settings = this.settings;
    if (!transport || !settings) return;

    if (
      settings.idleStopMs > 0 &&
      !this.stopped &&
      this.lastCommandAt > 0 &&
      Date.now() - this.lastCommandAt > settings.idleStopMs
    ) {
      this.stop();
      return;
    }
    if (this.stopped) return;

    const smoothing = clamp01(settings.smoothing);
    const parts: string[] = [];

    for (const row of this.enabledAxes()) {
      const axis = row.axis;
      const neutral = AXIS_NEUTRAL[axis];
      const target = clamp01(this.targets.get(axis) ?? neutral);
      const previous = clamp01(this.current.get(axis) ?? neutral);
      const eased =
        smoothing <= 0 ? target : previous + (target - previous) * (1 - smoothing);
      const next = Math.abs(target - eased) < 0.0005 ? target : eased;
      this.current.set(axis, next);

      const output = row.invert ? 1 - next : next;
      const quantized = Math.round(output * 9999);
      if (this.lastSent.get(axis) !== quantized) {
        parts.push(encodeAxis(axis, output));
        this.lastSent.set(axis, quantized);
      }
    }

    if (parts.length === 0) return;

    try {
      transport.send(encodeLine(parts));
      this.sentFrames += 1;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /** 设置单轴目标值（0-1，未反转）。rampMs > 0 时让设备自己做时间爬升。 */
  setAxis(axis: TCodeAxis, value: number, rampMs = 0): void {
    if (!this.transport) {
      throw new Error("设备尚未连接：请先调用「连接 OSR6」。");
    }
    const row = this.enabledAxes().find((entry) => entry.axis === axis);
    if (!row) return;
    const target = clamp01(value);
    this.stopped = false;
    this.lastCommandAt = Date.now();

    if (rampMs > 0) {
      const output = row.invert ? 1 - target : target;
      this.targets.set(axis, target);
      this.current.set(axis, target);
      this.lastSent.set(axis, Math.round(output * 9999));
      this.transport.send(encodeLine([encodeAxis(axis, output, rampMs)]));
      this.sentFrames += 1;
      return;
    }

    this.targets.set(axis, target);
  }

  /** 把多个轴一次设好，避免逐个调用时中间态被别的逻辑读到。 */
  setAxes(values: ReadonlyArray<{ axis: TCodeAxis; value: number }>): void {
    if (!this.transport) {
      throw new Error("设备尚未连接：请先调用「连接 OSR6」。");
    }
    const enabled = new Set(this.enabledAxes().map((row) => row.axis));
    const usable = values.filter((item) => enabled.has(item.axis));
    if (usable.length === 0) return;
    this.stopped = false;
    this.lastCommandAt = Date.now();
    for (const item of usable) {
      this.targets.set(item.axis, clamp01(item.value));
    }
  }

  /**
   * 直接落到目标值，跳过平滑，并立刻下发。
   *
   * 脚本播放时用这个：位置已经是对时间轴做好的线性插值，再叠一层平滑只会拖慢。
   * 立刻下发是为了去掉「等下一个定时器」的相位抖动——播放时每一帧位置都是
   * 时间敏感数据，攒到下一次 tick 再发会多出最多一个 tick 的延迟。
   */
  setAxisExact(axis: TCodeAxis, value: number): void {
    if (!this.transport) return;
    const row = this.enabledAxes().find((entry) => entry.axis === axis);
    if (!row) return;
    const next = clamp01(value);
    this.stopped = false;
    this.lastCommandAt = Date.now();
    this.targets.set(axis, next);
    this.current.set(axis, next);

    const output = row.invert ? 1 - next : next;
    const quantized = Math.round(output * 9999);
    if (this.lastSent.get(axis) === quantized) return;
    this.lastSent.set(axis, quantized);
    try {
      this.transport.send(encodeLine([encodeAxis(axis, output)]));
      this.sentFrames += 1;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  /** 紧急停止：发 DSTOP，之后不再发送任何位置帧。 */
  stop(): void {
    if (!this.transport) return;
    this.stopped = true;
    try {
      this.transport.send(encodeLine([TCODE_STOP]), true);
      this.sentFrames += 1;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    this.lastSent.clear();
  }

  /** 回到中位（线性 0.5 / 振动 0），用于剧情结束或切场景。 */
  recenter(): void {
    if (!this.transport) return;
    this.stopped = false;
    this.lastCommandAt = Date.now();
    for (const axis of TCODE_AXES) {
      this.targets.set(axis, AXIS_NEUTRAL[axis]);
    }
  }

  disconnect(): Promise<void> {
    ++this.revision;
    return this.enqueue(() => this.disconnectInternal());
  }

  private async disconnectInternal(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const transport = this.transport;
    this.transport = null;
    this.settings = null;
    if (transport) {
      try {
        transport.send(encodeLine([TCODE_STOP]), true);
      } catch {
        // 关闭前尽力而为，不阻断清理。
      }
      await transport.close().catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error);
      });
    }
    this.resetAxisState();
    this.stopped = false;
    this.lastCommandAt = 0;
  }

  snapshot(): EngineSnapshot {
    const targets: Array<{ axis: TCodeAxis; value: number }> = [];
    for (const [axis, value] of this.targets) {
      targets.push({ axis, value: Number(value.toFixed(3)) });
    }
    targets.sort((a, b) => a.axis.localeCompare(b.axis));
    return {
      connected: this.connected,
      transport: this.transport?.kind ?? null,
      endpoint: this.endpoint,
      targets,
      lastError: this.lastError,
      sentFrames: this.sentFrames,
    };
  }
}
