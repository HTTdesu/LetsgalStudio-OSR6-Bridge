import { encodeAxis, encodeLine, TCODE_STOP } from "./tcode";
import { createSerialTransport, listSerialDevices, SerialSelectionRequiredError, withTimeout, type SerialOptions } from "./transport";

export interface SerialProbeResult {
  ok: boolean;
  detail: string;
  motion?: boolean;
}

/** 仅查询身份，供内部诊断和无动作测试使用。 */
export function probeSerialDevice(options: SerialOptions, signal?: AbortSignal, timeoutMs = 1200): Promise<SerialProbeResult> {
  return runSerialProbe(options, false, signal, timeoutMs);
}

/** 用户主动点测试后：L0 中位 → 60% → 中位，每段缓动 600ms，最后停止。 */
export function testSerialDevice(options: SerialOptions, signal?: AbortSignal, timeoutMs = 1200): Promise<SerialProbeResult> {
  return runSerialProbe(options, true, signal, timeoutMs);
}

async function runSerialProbe(options: SerialOptions, motion: boolean, signal?: AbortSignal, timeoutMs = 1200): Promise<SerialProbeResult> {
  if (signal?.aborted) throw new Error("串口测试已取消。");
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let failure: Error | undefined;
  let motionStarted = false;
  let motionCompleted = false;
  const interrupted = new AbortController();
  const devices = await listSerialDevices(options);
  if (signal?.aborted) throw new Error("串口测试已取消。");
  const port = options.selectedPort ?? (devices.length === 1 ? devices[0].port : undefined);
  if (!port) throw new SerialSelectionRequiredError("请先在列表中选择要测试的串口。");
  const cancelRead = () => { void reader?.cancel().catch(() => undefined); };
  const transport = await createSerialTransport({ ...options, selectedPort: port, onError: (error) => {
    failure = error;
    interrupted.abort();
    cancelRead();
  } });
  const stop = () => transport.send(encodeLine([TCODE_STOP]), true);
  const cancel = () => {
    interrupted.abort();
    cancelRead();
    if (motionStarted) { try { stop(); } catch { /* 设备已断开时尽力停止 */ } }
  };
  const check = () => {
    if (failure) throw failure;
    if (signal?.aborted) throw new Error("串口测试已取消，已尝试发送停止指令。");
  };
  async function releaseReader() {
    const current = reader;
    reader = undefined;
    if (!current) return;
    await withTimeout(current.cancel(), 500, "取消串口读取超时").catch(() => undefined);
    current.releaseLock();
  }
  function waitMotion(ms: number): Promise<void> {
    check();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        interrupted.signal.removeEventListener("abort", onAbort);
        reject(failure ?? new Error("串口测试已取消，已尝试发送停止指令。"));
      };
      const timer = setTimeout(() => {
        interrupted.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      interrupted.signal.addEventListener("abort", onAbort, { once: true });
      if (interrupted.signal.aborted) onAbort();
    });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    signal?.addEventListener("abort", cancel, { once: true });
    check();
    reader = port.readable?.getReader();
    if (!reader) throw new Error("端口没有可读流，请先在设备列表中选择要测试的串口。");
    timer = setTimeout(cancelRead, timeoutMs);
    transport.send("D0\n");
    const decoder = new TextDecoder();
    let text = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (text.includes("\n")) break;
    }
    text += decoder.decode();
    clearTimeout(timer);
    timer = undefined;
    await releaseReader();
    await transport.drain();
    check();
    if (motion) {
      motionStarted = true;
      for (const position of [0.5, 0.6, 0.5]) {
        check();
        transport.send(encodeLine([encodeAxis("L0", position, 600)]));
        await transport.drain();
        await waitMotion(750);
      }
      check();
      stop();
      await transport.drain();
      motionCompleted = true;
      return { ok: true, detail: text.trim() || "connected-no-reply", motion: true };
    }
    return { ok: true, detail: text.trim() || "connected-no-reply" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    if (motionStarted && !motionCompleted) {
      try { stop(); await transport.drain(); } catch { /* 保留原始错误，仍释放端口 */ }
    }
    await releaseReader();
    await transport.close();
  }
}
