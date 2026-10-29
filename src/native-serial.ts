/** serialport adapter shared by desktop Studio and game previews. */
import type { SerialPort } from "serialport";
import { SerialSelectionRequiredError, type SerialApiLike, type SerialPortInfoLike, type SerialPortLike } from "./transport";

export type SerialPortConstructor = typeof SerialPort;
type PortRow = Awaited<ReturnType<SerialPortConstructor["list"]>>[number];

function deadline<T>(task: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    task.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function infoOf(row: PortRow): SerialPortInfoLike {
  const info: SerialPortInfoLike = {};
  if (row.vendorId && /^(?:0x)?[\da-f]{1,4}$/i.test(row.vendorId)) info.usbVendorId = parseInt(row.vendorId, 16);
  if (row.productId && /^(?:0x)?[\da-f]{1,4}$/i.test(row.productId)) info.usbProductId = parseInt(row.productId, 16);
  if (/BTHENUM|BTHMODEM|bluetooth|rfcomm/i.test([row.path, row.pnpId, row.manufacturer].join(" "))) {
    info.bluetoothServiceClassId = 0x1101;
  }
  return info;
}

class NativeSerialPort extends EventTarget implements SerialPortLike {
  readonly name: string;
  readonly displayName: string;
  connected = true;
  disconnectReason?: string;
  writable: WritableStream<Uint8Array> | null = null;
  readable: ReadableStream<Uint8Array> | null = null;
  private readonly info: SerialPortInfoLike;
  private serial?: SerialPort;
  private input?: ReadableStreamDefaultController<Uint8Array>;
  private output?: WritableStreamDefaultController;
  private buffered: Uint8Array[] = [];
  /** 缓冲已满时丢弃的读取块数（诊断用，正常应为 0）。 */
  droppedChunks = 0;
  private receiving = true;
  private opening?: Promise<void>;
  private closing?: Promise<void>;
  private pending = new Set<(error: Error) => void>();

  constructor(row: PortRow, readonly identity: string, private readonly api: NativeSerialApi) {
    super();
    this.name = row.path;
    this.info = infoOf(row);
    const description = (row as PortRow & { friendlyName?: string }).friendlyName || row.manufacturer;
    this.displayName = description ? (description.includes(row.path) ? description : `${description} (${row.path})`) : row.path;
  }
  getInfo(): SerialPortInfoLike { return this.info; }

  async open(options: { baudRate: number }): Promise<void> {
    if (!this.connected) throw new Error("所选系统串口已移除，请刷新列表。");
    if (this.serial || this.closing) throw new Error("系统串口正在使用或关闭，请稍后重试。");
    if (!Number.isInteger(options.baudRate) || options.baudRate < 1200 || options.baudRate > 921600) {
      throw new Error("波特率请填写 1200–921600 之间的整数。");
    }
    const Constructor = this.api.reserve(this);
    let serial: SerialPort;
    try {
      serial = new Constructor({ path: this.name, baudRate: options.baudRate, autoOpen: false,
        lock: true, dataBits: 8, stopBits: 1, parity: "none", highWaterMark: 4096 });
    } catch (error) { this.api.release(this); throw error; }
    this.serial = serial;
    this.receiving = true;
    let abandoned = false;
    serial.on("data", (bytes: Uint8Array) => {
      if (this.serial !== serial || !this.receiving) return;
      const copy = new Uint8Array(bytes);
      if (this.input && (this.input.desiredSize ?? 0) > -16) this.input.enqueue(copy);
      // 还没有 reader、或背压太深时先缓冲（有上限）；只有缓冲满了才丢弃并计数。
      else if (this.buffered.length < 16) this.buffered.push(copy);
      else this.droppedChunks += 1;
    });
    serial.on("error", (error: Error) => { if (this.serial === serial) this.disconnected(error); });
    serial.on("close", (error?: Error) => {
      if (this.serial === serial && !this.closing) this.disconnected(error ?? new Error("系统串口已断开。"));
    });
    this.opening = deadline(new Promise<void>((resolve, reject) => {
      serial.open((error) => {
        if (error) { reject(error); return; }
        if (abandoned || this.serial !== serial || !this.connected || this.api.disposed) {
          serial.close(() => undefined);
          reject(new Error("串口连接已取消。")); return;
        }
        resolve();
      });
    }), 10000, "打开系统串口超时，请检查设备是否在线或被其他应用占用。");
    try {
      await this.opening;
      if (!this.connected || this.api.disposed) throw new Error("串口连接已取消。");
      this.readable = new ReadableStream({
        start: (controller) => { this.input = controller; for (const bytes of this.buffered) controller.enqueue(bytes); this.buffered = []; },
        cancel: () => { this.input = undefined; this.receiving = false; this.buffered = []; },
      });
      this.writable = new WritableStream({
        start: (controller) => { this.output = controller; },
        write: (bytes) => this.write(serial, bytes),
      });
    } catch (error) {
      abandoned = true;
      if (serial.isOpen) serial.close(() => undefined);
      if (this.serial === serial) this.serial = undefined;
      this.buffered = []; this.api.release(this);
      throw error;
    } finally { this.opening = undefined; }
  }

  private async write(serial: SerialPort, bytes: Uint8Array): Promise<void> {
    if (!this.connected || this.serial !== serial || !serial.isOpen || this.closing) throw new Error("系统串口未打开。");
    let rejectPending: ((error: Error) => void) | undefined;
    try {
      await deadline(new Promise<void>((resolve, reject) => {
        rejectPending = reject; this.pending.add(reject);
        serial.write(bytes, (error) => {
          if (error) { reject(error); return; }
          if (this.serial !== serial || !serial.isOpen || this.closing) { reject(new Error("系统串口已关闭。")); return; }
          serial.drain((drainError) => { if (drainError) reject(drainError); else resolve(); });
        });
      }), 2000, "系统串口写入超时。");
    } catch (error) {
      this.disconnected(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally { if (rejectPending) this.pending.delete(rejectPending); }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    // Defer work until closing is assigned, since serialport may emit close synchronously.
    this.closing = Promise.resolve().then(async () => {
      try {
        await this.opening?.catch(() => undefined);
        const serial = this.serial;
        for (const reject of this.pending) reject(new Error("系统串口已关闭。"));
        this.pending.clear();
        if (serial?.isOpen) {
          await deadline(new Promise<void>((resolve, reject) => {
            serial.close((error) => { if (error) reject(error); else resolve(); });
          }), 2000, "关闭系统串口超时。");
        }
      } finally {
        this.serial = undefined;
        try { this.input?.close(); } catch { /* Reader already canceled or errored. */ }
        this.input = undefined; this.output = undefined; this.buffered = [];
        this.readable = null; this.writable = null;
        this.api.release(this);
      }
    }).finally(() => { this.closing = undefined; });
    return this.closing;
  }

  disconnected(error: Error): void {
    if (!this.connected) return;
    this.connected = false; this.disconnectReason = error.message;
    for (const reject of this.pending) reject(error);
    this.pending.clear();
    try { this.input?.error(error); } catch { /* Already canceled. */ }
    try { this.output?.error(error); } catch { /* Already closed. */ }
    this.input = undefined; this.output = undefined;
    this.dispatchEvent(new Event("disconnect"));
    void this.close().catch(() => undefined);
  }
}

export class NativeSerialApi implements SerialApiLike {
  readonly requiresExplicitSelection = true;
  disposed = false;
  private ports = new Map<string, NativeSerialPort>();
  private active?: NativeSerialPort;
  private listing?: Promise<SerialPortLike[]>;
  constructor(private readonly load: () => SerialPortConstructor) {}

  getPorts(): Promise<SerialPortLike[]> {
    if (this.disposed) return Promise.reject(new Error("串口会话已结束，请重新打开设备面板。"));
    if (this.listing) return this.listing;
    this.listing = Promise.resolve().then(async () => {
      const rows = await deadline(this.load().list(), 8000, "读取系统串口列表超时。");
      if (this.disposed) throw new Error("串口会话已结束。");
      const next = new Map<string, NativeSerialPort>();
      for (const row of rows.slice().sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))) {
        const identity = JSON.stringify([row.path, row.pnpId, row.serialNumber, row.vendorId, row.productId, row.locationId]);
        let port = this.ports.get(row.path);
        if (!port || !port.connected || port.identity !== identity) port = new NativeSerialPort(row, identity, this);
        next.set(row.path, port);
      }
      for (const [name, port] of this.ports) {
        if (next.get(name) !== port) port.disconnected(new Error("系统串口已移除或已更换设备。"));
      }
      this.ports = next;
      return [...next.values()];
    }).finally(() => { this.listing = undefined; });
    return this.listing;
  }
  requestPort(): Promise<SerialPortLike> {
    return Promise.reject(new SerialSelectionRequiredError("请从系统串口列表中手动选择设备。"));
  }
  reserve(port: NativeSerialPort): SerialPortConstructor {
    if (this.disposed) throw new Error("串口会话已结束。");
    if (this.ports.get(port.name) !== port) throw new Error("所选串口已变化，请刷新并重新选择。");
    if (this.active) throw new Error("原生串口已被当前会话占用。");
    const Constructor = this.load();
    this.active = port;
    return Constructor;
  }
  release(port: NativeSerialPort): void { if (this.active === port) this.active = undefined; }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const port of this.ports.values()) port.disconnected(new Error("串口会话已结束。"));
    await this.active?.close().catch(() => undefined);
    this.ports.clear();
  }
}
