import { NativeSerialApi, type SerialPortConstructor } from "../../src/native-serial";

const requests: string[] = [];
function log(message: string) {
  requests.push(message);
  const target = document.getElementById("serial-log");
  if (target) target.textContent = "模拟串口请求：" + requests.join(" → ");
}
class PreviewSerialPort {
  constructor(private readonly options: { path: string }) {}
  static async list() {
    log("list");
    return ["COM3", "COM7"].map((path) => ({ path, manufacturer: "测试 OSR", vendorId: "1234", productId: "5678" }));
  }
  isOpen = false;
  listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  on(name: string, callback: (...args: unknown[]) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); return this;
  }
  emit(name: string, ...args: unknown[]) { for (const callback of this.listeners.get(name) ?? []) callback(...args); }
  open(callback: (error?: Error) => void) { log("open"); this.isOpen = true; queueMicrotask(() => callback()); }
  close(callback: (error?: Error) => void) { log("close"); this.isOpen = false; queueMicrotask(() => { this.emit("close"); callback(); }); }
  write(bytes: Uint8Array, callback: (error?: Error) => void) {
    const text = new TextDecoder().decode(bytes); log(text.trim());
    queueMicrotask(() => {
      if (text === "D0\n") this.emit("data", new TextEncoder().encode("OSR6 mock " + this.options.path + "\n"));
      callback();
    });
    return true;
  }
  drain(callback: (error?: Error) => void) { queueMicrotask(() => callback()); }
}
export function createStudioSerialApi() {
  return new NativeSerialApi(() => PreviewSerialPort as unknown as SerialPortConstructor);
}
