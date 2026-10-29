/** Editor UDP motion test. The caller owns cancellation (stop/page unmount). */
export interface UdpProbeModule {
  createSocket(type: "udp4"): {
    on(event: string, listener: (...args: unknown[]) => void): void;
    send(message: string, port: number, host: string, callback: (error: Error | null) => void): void;
    close(): void;
  };
}

export interface UdpProbeResult {
  ok: boolean;
  detail: string;
  cancelled?: boolean;
}

export function probeUdpDevice(options: {
  host: string; port: number; dgram: UdpProbeModule; signal?: AbortSignal;
}): Promise<UdpProbeResult> {
  const { host, port, dgram, signal } = options;
  if (signal?.aborted) return Promise.resolve({ ok: false, cancelled: true, detail: "测试已取消。" });
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let settled = false;
    let closed = false;
    let reply = "";
    let motionStarted = false;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: UdpProbeResult, sendStop = motionStarted) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      signal?.removeEventListener("abort", cancel);
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(releaseTimer);
        try { socket.close(); } catch { /* The socket may already be closed. */ }
        resolve(result);
      };
      if (!sendStop) { close(); return; }
      // Give the stop datagram a chance to leave before closing the socket.
      // A missing driver callback must not retain the test session indefinitely.
      releaseTimer = setTimeout(() => {
        if (result.ok) { result.ok = false; result.detail = "发送停止指令超时。"; }
        close();
      }, 500);
      try {
        socket.send("DSTOP\n", port, host, (error) => {
          if (error && result.ok) { result.ok = false; result.detail = error.message; }
          close();
        });
      } catch (error) {
        if (result.ok) { result.ok = false; result.detail = String(error); }
        close();
      }
    };
    const cancel = () => finish({ ok: false, cancelled: true, detail: "测试已取消，已尝试发送停止指令。" }, true);
    const send = (payload: string) => {
      if (settled || signal?.aborted) return false;
      if (payload.startsWith("L0")) motionStarted = true;
      try {
        socket.send(payload, port, host, (error) => {
          if (error) finish({ ok: false, detail: error.message });
        });
      } catch (error) {
        finish({ ok: false, detail: error instanceof Error ? error.message : String(error) });
      }
      return !settled;
    };
    socket.on("message", (message) => { if (!settled && message != null) reply = String(message).trim(); });
    socket.on("error", (error) => finish({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    if (!send("D0\n")) return;
    for (const [ms, command] of [[100, "L05000I300\n"], [700, "L06500I600\n"], [1500, "L05000I600\n"]] as const) {
      timers.push(setTimeout(() => send(command), ms));
    }
    timers.push(setTimeout(() => finish({ ok: true, detail: reply ? "reply:" + reply : "sent" }), 2400));
  });
}
