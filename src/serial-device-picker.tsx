import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { EngineSnapshot } from "./engine";
import {
  errorMessage, listSerialDevices, requestSerialDevice, serialRequestErrorMessage, serialUnavailableReason,
  type SerialBackend, type SerialKind, type SerialOptions, type SerialPortLike,
} from "./transport";

export interface SerialDevicePickerProps {
  id?: string;
  signal: AbortSignal;
  initialBackend?: SerialBackend;
  getOptions(backend?: SerialBackend): SerialOptions;
  snapshot(): EngineSnapshot;
  connect(port: SerialPortLike, kind: SerialKind, baudRate: number, backend?: SerialBackend): Promise<void>;
  disconnect(): Promise<void>;
  stop(): void;
  close(): Promise<void>;
}

const button: CSSProperties = {
  border: "1px solid #44625f", borderRadius: 8, padding: "10px 16px",
  background: "#18312f", color: "#f4f8f7", font: "inherit", cursor: "pointer",
};

/** 只负责串口授权与选择，不重做已有可视化设置页。真实点击直接触发设备授权。 */
export function SerialDevicePicker(props: SerialDevicePickerProps) {
  const [backend, setBackend] = useState<SerialBackend>(props.initialBackend ?? "web");
  const [kind, setKind] = useState<SerialKind>(() => props.getOptions().kind ?? "auto");
  const [baud, setBaud] = useState(() => String(props.getOptions().baudRate));
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof listSerialDevices>>>([]);
  const [snapshot, setSnapshot] = useState(props.snapshot);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  const generation = useRef(0);
  const unavailable = backend === "web" ? serialUnavailableReason() : null;
  const options = (): SerialOptions => ({ ...props.getOptions(backend), kind, baudRate: Number(baud) });
  const alive = () => mounted.current && !props.signal.aborted;

  async function refresh() {
    const current = ++generation.current;
    try {
      const result = await listSerialDevices(options());
      if (alive() && current === generation.current) setDevices(result);
    } catch (error) {
      if (alive() && current === generation.current) { setDevices([]); setMessage(errorMessage(error)); }
    }
  }

  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => { if (alive()) setSnapshot(props.snapshot()); }, 400);
    return () => { mounted.current = false; ++generation.current; clearInterval(timer); };
  }, [props.signal]);

  useEffect(() => { setDevices([]); void refresh(); }, [kind, backend]);

  async function connect(port: SerialPortLike) {
    if (!alive()) return;
    setBusy(true); setMessage("");
    try {
      await props.connect(port, kind, Number(baud), backend);
      if (alive()) { setSnapshot(props.snapshot()); setMessage("已连接。点击「关闭」继续游戏；连接本身不会触发运动。"); }
    } catch (error) {
      if (alive()) setMessage(errorMessage(error));
    } finally { if (alive()) setBusy(false); }
  }

  function authorize() {
    const value = Number(baud);
    if (!Number.isInteger(value) || value < 1200 || value > 921600) {
      setMessage("波特率请填写 1200–921600 之间的整数。"); return;
    }
    // 不能先 await disconnect/getPorts：必须保留这次点击的用户激活。
    let request: Promise<SerialPortLike>;
    try { request = requestSerialDevice(options()); }
    catch (error) { setMessage(errorMessage(error)); return; }
    setBusy(true); setMessage("");
    void request.then(async (port) => {
      if (!alive()) return;
      await connect(port);
      if (alive()) await refresh();
    }).catch((error: unknown) => {
      if (alive()) setMessage(serialRequestErrorMessage(error));
    }).finally(() => { if (alive()) setBusy(false); });
  }

  async function disconnect() {
    setBusy(true);
    try { await props.disconnect(); if (alive()) { setSnapshot(props.snapshot()); setMessage("已断开并释放串口。"); } }
    catch (error) { if (alive()) setMessage(errorMessage(error)); }
    finally { if (alive()) setBusy(false); }
  }

  return (
    <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(3,8,13,.82)", padding: "3%", boxSizing: "border-box", color: "#f4f8f7", fontFamily: "system-ui, sans-serif", pointerEvents: "auto" }}>
      <section role="dialog" aria-modal="true" aria-label="选择串口设备" style={{ width: "min(720px, 100%)", maxHeight: "100%", overflow: "auto", padding: "clamp(16px, 3%, 32px)", boxSizing: "border-box", border: "1px solid #44625f", borderRadius: 16, background: "#0b171e" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <h2 style={{ margin: 0 }}>选择串口设备</h2>
          <button type="button" autoFocus style={button} disabled={busy} onClick={() => void props.close().catch((error: unknown) => setMessage(errorMessage(error)))}>关闭</button>
        </div>
        <p>USB 可直接连接；传统蓝牙串口（SPP）请先在系统设置里配对。仅有 BLE 的设备暂不支持。</p>
        <div role="group" aria-label="串口访问方式" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {([['web', '浏览器授权'], ['native', '桌面原生串口']] as const).map(([value, label]) => (
            <button type="button" key={value} aria-pressed={backend === value} disabled={busy} style={{ ...button, background: backend === value ? "#32665e" : "#18312f" }} onClick={() => { setMessage(""); setBackend(value); }}>{label}</button>
          ))}
        </div>
        {backend === "native" ? <p>通过桌面系统串口连接，支持 Windows、macOS 和 Linux。请从列表中确认设备后连接。</p> : null}
        <div role="group" aria-label="串口类型" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {([['auto', '自动识别'], ['usb', 'USB'], ['bluetooth', '蓝牙串口 SPP']] as const).map(([value, label]) => (
            <button type="button" key={value} aria-pressed={kind === value} disabled={busy} style={{ ...button, background: kind === value ? "#32665e" : "#18312f" }} onClick={() => setKind(value)}>{label}</button>
          ))}
        </div>
        <label style={{ display: "flex", gap: 12, alignItems: "center", margin: "18px 0" }}>
          波特率 <input aria-label="波特率" type="number" min={1200} max={921600} value={baud} disabled={busy} onChange={(event) => setBaud(event.target.value)} style={{ ...button, width: 140, cursor: "text" }} />
        </label>
        {unavailable ? <p role="alert">{unavailable}</p> : <>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {backend === "web" ? <button type="button" style={button} disabled={busy} onClick={authorize}>{busy ? "处理中…" : "选择 / 授权新设备…"}</button> : null}
            <button type="button" style={button} disabled={busy} onClick={() => void refresh()}>{backend === "native" ? "刷新系统串口" : "刷新已授权设备"}</button>
          </div>
          <p>{backend === "native" ? "系统串口" : "已授权设备"}（列表序号可能变化，请确认设备后连接）：</p>
          {devices.length === 0 ? <p>{backend === "native" ? "暂未找到匹配的系统串口，请检查接线、驱动和筛选条件后刷新。" : "没有匹配的设备。请先选择 / 授权设备。"}</p> : devices.map((item) => (
            <button type="button" key={item.index} style={{ ...button, display: "block", width: "100%", marginTop: 8, textAlign: "left" }} disabled={busy} onClick={() => void connect(item.port)}>{item.label} · 连接</button>
          ))}
        </>}
        <p role="status" aria-live="polite">{snapshot.connected ? "已连接：" + snapshot.endpoint : "未连接"}{snapshot.lastError ? " · " + snapshot.lastError : ""}</p>
        {message ? <p role="status">{message}</p> : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" style={{ ...button, background: "#7a3139" }} onClick={() => { props.stop(); setMessage("已急停，后续运动帧已清除。"); }}>急停</button>
          <button type="button" style={button} disabled={busy || !snapshot.connected} onClick={() => void disconnect()}>断开设备</button>
        </div>
      </section>
    </div>
  );
}
