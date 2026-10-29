/** UDP / USB / 传统蓝牙串口传输；浏览器串口不依赖 Node，桌面可注入原生通道。 */
interface DgramSocketLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  send(text: string, port: number, host: string, callback: (error: Error | null) => void): void;
  close(callback: () => void): void;
}

export type SerialKind = "auto" | "usb" | "bluetooth";
export type SerialBackend = "web" | "native";
export interface SerialPortInfoLike {
  usbVendorId?: number;
  usbProductId?: number;
  bluetoothServiceClassId?: string | number;
}
export interface SerialPortLike {
  readonly displayName?: string;
  readonly disconnectReason?: string;
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfoLike;
  readonly writable: WritableStream<Uint8Array> | null;
  readonly readable?: ReadableStream<Uint8Array> | null;
  readonly connected?: boolean;
  addEventListener?(type: string, listener: EventListener): void;
  removeEventListener?(type: string, listener: EventListener): void;
}
interface SerialRequestOptions {
  filters?: Array<{ usbVendorId?: number; usbProductId?: number; bluetoothServiceClassId?: string | number }>;
}
export interface SerialApiLike {
  readonly requiresExplicitSelection?: boolean;
  getPorts(): Promise<SerialPortLike[]>;
  requestPort(options?: SerialRequestOptions): Promise<SerialPortLike>;
}
export interface SerialOptions {
  /** 桌面原生串口可注入系统端口列表；网页始终使用 navigator.serial。 */
  api?: SerialApiLike;
  baudRate: number;
  kind?: SerialKind;
  vendorId?: number;
  productId?: number;
  /** 仅用于旧配置兼容，自动连接不把列表序号当设备身份。 */
  portIndex?: number;
  selectedPort?: SerialPortLike;
  onError?: (error: Error) => void;
}
export interface Transport {
  readonly kind: "udp" | "serial";
  readonly endpoint: string;
  /** urgent 清除尚未写出的运动帧；已提交给驱动的写入无法撤回。 */
  send(text: string, urgent?: boolean): void;
  close(): Promise<void>;
}
export interface SerialTransport extends Transport {
  /** 等待已经排入的指令写完；用于试动阶段之间精确等待与错误反馈。 */
  drain(): Promise<void>;
}
export class SerialSelectionRequiredError extends Error {
  constructor(message = "请点击「选择串口设备」，授权并选择 USB 或传统蓝牙串口。") {
    super(message);
    this.name = "SerialSelectionRequiredError";
  }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function serialKind(value: unknown): SerialKind {
  return value === "usb" || value === "bluetooth" ? value : "auto";
}
export function serialBackend(value: unknown): SerialBackend {
  return value === "native" || value === "windows" ? "native" : "web";
}
export function serialRequestErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "NotFoundError") {
    return "未选择串口。如果没有出现选择窗口，可能是 Studio 未接入串口选择界面；桌面版可改用「桌面原生串口」。如果出现了空列表，请检查 USB 接线、驱动或蓝牙配对。";
  }
  return errorMessage(error);
}
export function parseUsbId(raw: string | undefined): number | undefined {
  const text = (raw ?? "").trim();
  if (!text) return undefined;
  if (!/^(?:0x[0-9a-f]+|\d+)$/i.test(text)) throw new Error("USB ID 必须是十进制或 0x 开头的十六进制数字。");
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error("USB ID 必须在 0–65535 之间。");
  return value;
}
export function getSerialApi(): SerialApiLike | null {
  if (typeof navigator === "undefined") return null;
  const api = (navigator as unknown as { serial?: SerialApiLike }).serial;
  return api && typeof api.getPorts === "function" && typeof api.requestPort === "function" ? api : null;
}
export function serialUnavailableReason(): string | null {
  if (typeof window !== "undefined" && window.isSecureContext === false) return "串口需要安全页面。网页版请使用 HTTPS 或 localhost。";
  if (!getSerialApi()) return "当前窗口未开放 Web Serial。请使用支持串口的桌面浏览器，或让 Studio / 桌面游戏宿主开放串口权限。";
  if (typeof document !== "undefined") {
    const page = document as unknown as {
      permissionsPolicy?: { allowsFeature(name: string): boolean };
      featurePolicy?: { allowsFeature(name: string): boolean };
    };
    const policy = page.permissionsPolicy ?? page.featurePolicy;
    if (policy && !policy.allowsFeature("serial")) return "当前嵌入页面未允许串口。请让网页宿主为游戏开放 serial 权限，或在独立页面打开游戏。";
  }
  return null;
}
export function matchesSerialPort(port: SerialPortLike, options: SerialOptions): boolean {
  const info = port.getInfo();
  const bluetooth = info.bluetoothServiceClassId !== undefined;
  if (options.kind === "usb" && bluetooth) return false;
  if (options.kind === "bluetooth") {
    // 老宿主的映射 COM 口可能没有蓝牙标识，仍允许手动选择。
    return bluetooth || (info.usbVendorId === undefined && info.usbProductId === undefined);
  }
  if (options.vendorId !== undefined && info.usbVendorId !== options.vendorId) return false;
  if (options.productId !== undefined && info.usbProductId !== options.productId) return false;
  return true;
}
export function describeSerialPort(port: SerialPortLike): string {
  if (port.displayName) return port.displayName;
  const info = port.getInfo();
  if (info.bluetoothServiceClassId !== undefined) return `蓝牙串口 SPP (${info.bluetoothServiceClassId})`;
  const ids: string[] = [];
  if (info.usbVendorId !== undefined) ids.push(`VID:${info.usbVendorId.toString(16).padStart(4, "0")}`);
  if (info.usbProductId !== undefined) ids.push(`PID:${info.usbProductId.toString(16).padStart(4, "0")}`);
  return ids.length ? `USB ${ids.join(" ")}` : "串口（宿主未提供设备标识）";
}
export async function listSerialDevices(options: SerialOptions): Promise<Array<{ port: SerialPortLike; index: number; label: string }>> {
  const reason = options.api ? null : serialUnavailableReason();
  if (reason) throw new Error(reason);
  const ports = await (options.api ?? getSerialApi()!).getPorts();
  return ports.flatMap((port, index) => matchesSerialPort(port, options)
    ? [{ port, index, label: `#${index} ${describeSerialPort(port)}` }] : []);
}
/** 必须在真实点击里直接调用；调用前不能 await 断开、刷新或加载模块。 */
export function requestSerialDevice(options: SerialOptions): Promise<SerialPortLike> {
  const reason = options.api ? null : serialUnavailableReason();
  if (reason) return Promise.reject(new Error(reason));
  let request: SerialRequestOptions | undefined;
  if (options.kind === "bluetooth") request = { filters: [{ bluetoothServiceClassId: 0x1101 }] };
  else if (options.vendorId !== undefined) {
    request = { filters: [{ usbVendorId: options.vendorId, ...(options.productId === undefined ? {} : { usbProductId: options.productId }) }] };
  }
  return (options.api ?? getSerialApi()!).requestPort(request).then((port) => {
    if (!matchesSerialPort(port, options)) throw new Error("选择的设备不符合当前串口类型或 USB ID，请重新选择。");
    return port;
  });
}
async function grantedPort(options: SerialOptions): Promise<SerialPortLike> {
  if (options.api?.requiresExplicitSelection && !options.selectedPort) {
    throw new SerialSelectionRequiredError("请在设备选择面板中选择系统串口；原生串口不会自动选择设备。");
  }
  const devices = await listSerialDevices(options);
  if (options.selectedPort) {
    if (!devices.some((item) => item.port === options.selectedPort)) throw new SerialSelectionRequiredError("原设备已移除、授权失效或不符合筛选条件，请重新选择。");
    if (options.selectedPort.connected === false) throw new SerialSelectionRequiredError("所选串口已断开，请接好 USB 或连接蓝牙后重新选择。");
    return options.selectedPort;
  }
  const available = devices.filter((item) => item.port.connected !== false);
  if (available.length !== 1) throw new SerialSelectionRequiredError(available.length > 1
    ? "找到多个已授权串口，请手动选择设备；不会自动连接列表中的第一个。" : undefined);
  return available[0].port;
}
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  })]).finally(() => clearTimeout(timer));
}
// 只仲裁物理端口，不保存引擎上下文。
const occupiedPorts = new WeakSet<SerialPortLike>();

export async function createSerialTransport(options: SerialOptions): Promise<SerialTransport> {
  const port = await grantedPort(options);
  if (occupiedPorts.has(port)) throw new Error("串口正在使用中，请先结束其他预览或串口测试。");
  occupiedPorts.add(port);
  let opened = false;
  let writer: WritableStreamDefaultWriter<Uint8Array>;
  try {
    await port.open({ baudRate: options.baudRate, bufferSize: 4096 });
    opened = true;
    if (!port.writable) throw new Error("串口已打开，但没有可写流。");
    writer = port.writable.getWriter();
  } catch (error) {
    if (opened) await port.close().catch(() => undefined);
    occupiedPorts.delete(port);
    throw error;
  }
  const encoder = new TextEncoder();
  const positions = new Map<string, string>();
  const commands: string[] = [];
  let pending: Promise<void> | null = null;
  let closing = false;
  let closePromise: Promise<void> | null = null;
  let failure: Error | null = null;
  const fail = (error: unknown) => {
    if (failure) return;
    failure = new Error(`串口连接中断：${errorMessage(error)}`);
    positions.clear();
    commands.length = 0;
    if (!closing) options.onError?.(failure);
  };
  const disconnected: EventListener = () => fail(new Error(port.disconnectReason ?? "设备已断开"));
  port.addEventListener?.("disconnect", disconnected);
  const pump = (): Promise<void> => {
    if (pending) return pending;
    pending = (async () => {
      while (!failure && (commands.length || positions.size)) {
        const command = commands.shift();
        const text = command ?? `${Array.from(positions.values()).join(" ")}\n`;
        if (command === undefined) positions.clear();
        await withTimeout(writer.write(encoder.encode(text)), 2000, "串口写入超时");
      }
    })().catch(fail).finally(() => {
      pending = null;
      if (!closing && !failure && (commands.length || positions.size)) void pump();
    });
    return pending;
  };
  return {
    kind: "serial",
    endpoint: `${describeSerialPort(port)} @${options.baudRate}`,
    async drain() {
      do {
        if (failure) throw failure;
        await pump();
        if (failure) throw failure;
      } while (pending || commands.length || positions.size);
    },
    send(text, urgent = false) {
      if (failure) throw failure;
      if (closing) return;
      if (urgent) {
        positions.clear(); commands.length = 0; commands.push(text);
      } else {
        const tokens = text.trim().split(/\s+/);
        if (tokens.every((token) => /^[LRVA]\d\d{4}(?:I\d+)?$/.test(token))) {
          for (const token of tokens) positions.set(token.slice(0, 2), token);
        } else {
          if (commands.length >= 16) throw new Error("串口控制指令过多，请降低发送频率。");
          commands.push(text);
        }
      }
      void pump();
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      port.removeEventListener?.("disconnect", disconnected);
      closePromise = (async () => {
        try {
          await withTimeout(pump(), 2200, "等待串口写入结束超时");
          if (failure) await withTimeout(writer.abort(), 300, "中止串口超时").catch(() => undefined);
        } finally {
          writer.releaseLock();
          try { await withTimeout(port.close(), 1500, "关闭串口超时；请重新插拔设备"); }
          finally { occupiedPorts.delete(port); }
        }
      })();
      return closePromise;
    },
  };
}

export function createUdpTransport(options: { host: string; port: number; dgram: unknown; onError?: (error: Error) => void }): Transport {
  const module = options.dgram as { createSocket(type: "udp4"): DgramSocketLike };
  const socket = module.createSocket("udp4");
  let closed = false;
  socket.on("error", (error) => { if (!closed) options.onError?.(new Error(errorMessage(error))); });
  return {
    kind: "udp",
    endpoint: `${options.host}:${options.port}`,
    send(text) {
      if (closed) return;
      socket.send(text, options.port, options.host, (error) => { if (error && !closed) options.onError?.(error); });
    },
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => { try { socket.close(resolve); } catch { resolve(); } });
    },
  };
}
