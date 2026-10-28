/**
 * 传输层：把 TCode 文本送到设备。
 *
 * 两条通道：
 * - `udp`：OSR6 / SR6 等设备开启 WiFi 后监听 UDP（参考实现里是 `192.168.1.1:8000`），
 *   通过宿主的 `ctx.native.node` 拿 `node:dgram`，不依赖任何 npm 原生包。
 * - `serial`：USB 串口，走 Chromium 的 Web Serial（`navigator.serial`）。
 *   串口不需要联网，但需要宿主允许访问串口设备。
 *
 * 这里刻意只做「把一行文本发出去」这一件事，编码和节流都不在这里。
 */

/** node:dgram 的最小类型契约（不引入 @types/node 依赖）。 */
interface DgramSocketLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  send(
    msg: string,
    port: number,
    address: string,
    callback?: (error: Error | null) => void,
  ): void;
  close(callback?: () => void): void;
}

interface DgramModuleLike {
  createSocket(type: "udp4"): DgramSocketLike;
}

/** Web Serial 的最小类型契约（不引入额外类型包）。 */
interface SerialPortInfoLike {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialPortLike {
  open(options: { baudRate: number; bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfoLike;
  readonly writeable?: WritableStream<Uint8Array> | null;
  readonly writable?: WritableStream<Uint8Array> | null;
}

interface SerialLike {
  getPorts(): Promise<SerialPortLike[]>;
  requestPort(options?: { filters?: Array<{ usbVendorId?: number }> }): Promise<SerialPortLike>;
}

export interface Transport {
  readonly kind: "udp" | "serial";
  /** 人类可读的端点描述，用于状态展示。 */
  readonly endpoint: string;
  send(text: string): void;
  close(): Promise<void>;
}

export interface UdpOptions {
  host: string;
  port: number;
  /** `node:dgram` 模块本身（调用方用字面量从宿主要到，不在这里转发）。 */
  dgram: unknown;
}

export function createUdpTransport(options: UdpOptions): Transport {
  const dgram = options.dgram as DgramModuleLike;
  const socket = dgram.createSocket("udp4");
  let closed = false;
  let lastError: Error | null = null;

  socket.on("error", (...args: unknown[]) => {
    const error = args[0];
    lastError = error instanceof Error ? error : new Error(String(error));
  });

  return {
    kind: "udp",
    endpoint: `${options.host}:${options.port}`,
    send(text: string): void {
      if (closed) return;
      socket.send(text, options.port, options.host, (error) => {
        if (error) lastError = error;
      });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      lastError = null;
      await new Promise<void>((resolve) => {
        socket.close(() => resolve());
      });
    },
  };
}

export interface SerialOptions {
  baudRate: number;
  /** 可选的 USB 厂商 ID 过滤（十进制或 0x 十六进制字符串）。 */
  vendorId?: number;
  productId?: number;
  /**
   * 在候选端口里的序号（0 起）。
   *
   * Web Serial 没有"枚举所有 COM 口"的接口，只能看到用户授权过的那些。
   * 所以这里按 `getPorts()` 的顺序取，序号就是编辑器里列出来的那一行。
   */
  portIndex?: number;
}

function getSerialApi(): SerialLike | null {
  if (typeof navigator === "undefined") return null;
  const candidate = (navigator as unknown as { serial?: SerialLike }).serial;
  return candidate ?? null;
}

function matchesUsbFilter(info: SerialPortInfoLike, options: SerialOptions): boolean {
  if (options.vendorId !== undefined && info.usbVendorId !== options.vendorId) {
    return false;
  }
  if (options.productId !== undefined && info.usbProductId !== options.productId) {
    return false;
  }
  return true;
}

function describeUsb(info: SerialPortInfoLike): string {
  const parts: string[] = [];
  if (info.usbVendorId !== undefined) {
    parts.push(`VID:${info.usbVendorId.toString(16).padStart(4, "0")}`);
  }
  if (info.usbProductId !== undefined) {
    parts.push(`PID:${info.usbProductId.toString(16).padStart(4, "0")}`);
  }
  return parts.length > 0 ? parts.join(" ") : "未提供 USB 标识";
}

/**
 * 打开串口。
 *
 * 优先复用用户已经授权过的端口（`getPorts`），没有授权记录时才弹出选择框。
 * 宿主没有开启串口能力时，这里会抛出中文错误，调用方应提示改用 UDP。
 */
export async function createSerialTransport(options: SerialOptions): Promise<Transport> {
  const serial = getSerialApi();
  if (!serial) {
    throw new Error(
      "当前宿主没有提供 Web Serial（navigator.serial），串口通道不可用；请改用 UDP 连接。",
    );
  }

  let granted: SerialPortLike[] = [];
  try {
    granted = await serial.getPorts();
  } catch {
    granted = [];
  }

  // 候选端口：设了 VID/PID 就在过滤后的列表里选，否则按授权列表的顺序选。
  const filtered = granted.filter((port) => matchesUsbFilter(port.getInfo(), options));
  const candidates =
    options.vendorId === undefined && options.productId === undefined ? granted : filtered;
  const index = Math.max(0, Math.round(options.portIndex ?? 0));
  let port: SerialPortLike | null = candidates[index] ?? candidates[0] ?? null;

  if (!port) {
    try {
      port = await serial.requestPort(
        options.vendorId === undefined
          ? undefined
          : { filters: [{ usbVendorId: options.vendorId }] },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `无法获得串口访问权限（${reason}）。请在 Studio 里允许串口设备，或改用 UDP 连接。`,
      );
    }
  }

  await port.open({ baudRate: options.baudRate, bufferSize: 4096 });

  const stream = port.writable ?? port.writeable ?? null;
  if (!stream) {
    await port.close().catch(() => undefined);
    throw new Error("串口已打开但没有可写流，无法发送 TCode。");
  }
  const writer = stream.getWriter();
  const encoder = new TextEncoder();
  let closed = false;

  return {
    kind: "serial",
    endpoint: `serial ${describeUsb(port.getInfo())} @${options.baudRate}`,
    send(text: string): void {
      if (closed) return;
      void writer.write(encoder.encode(text)).catch(() => undefined);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await writer.close().catch(() => undefined);
      await port.close().catch(() => undefined);
    },
  };
}
