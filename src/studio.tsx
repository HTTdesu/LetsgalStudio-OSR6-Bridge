/**
 * Studio 编辑期入口：自定义设置页。
 *
 * 两个功能：
 * 1. 「导入 funscript」：选 .funscript → 打包成 WAV 载波 → 写进项目 assets/。
 * 2. 「设备连接」：配置 UDP / USB / 传统蓝牙串口，并短暂测试设备。
 *
 * 几点说明：
 * - Studio 的素材管线不接受 .funscript，编辑器页面也没有「导入素材」的接口，
 *   所以导入直接把文件写到 `<项目目录>/assets/<子目录>/`，创作者刷新资产即可看到。
 * - 本地设备测试按用户要求复用宿主 Node；浏览器串口仍使用 Web Serial。
 * - 串口测试临时打开并释放端口，不建立常驻连接，请先断开预览设备。
 */
import { useEffect, useRef, useState } from "react";
import { AutoSettings, toast, useSetting, useStudioLocale } from "@avg-studio/studio-ui";
import { Btn, Card, Dropdown, Input, Row, Segmented, Toggle, Value } from "./ui-kit";
import { COLORS, TYPE } from "./ui-theme";
import { encodeCarrierWav } from "./carrier";
import { parseFunscript } from "./funscript";
import { testSerialDevice } from "./serial-probe";
import { probeUdpDevice, type UdpProbeModule } from "./udp-probe";
import { createStudioSerialApi } from "./studio-serial";
import type { NativeSerialApi } from "./native-serial";
import {
  errorMessage, listSerialDevices, requestSerialDevice, serialBackend, serialKind, serialRequestErrorMessage,
  serialUnavailableReason, describeSerialPort, type SerialApiLike, type SerialOptions, type SerialPortLike,
} from "./transport";

interface Text {
  importTitle: string;
  folder: string;
  folderHint: string;
  overwrite: string;
  choose: string;
  chosen: string;
  summary: string;
  run: string;
  done: string;
  hint: string;
  noProject: string;
  badFolder: string;
  other: string;
  connTitle: string;
  mode: string;
  modeUdp: string;
  modeSerial: string;
  deviceHost: string;
  devicePort: string;
  baudRate: string;
  status: string;
  connHint: string;
  noNode: string;
  testConn: string;
  testing: string;
  testOk: string;
  testReply: string;
  testNoReply: string;
  testSerialHint: string;
  testNoReplyDetail: string;
  notTested: string;
  portLabel: string;
  portRefresh: string;
  portGrant: string;
  portEmpty: string;
  portNoApi: string;
  portInactive: string;
  grantFailed: string;
  serialType: string;
  serialAuto: string;
  serialBluetooth: string;
  bluetoothHint: string;
  serialOk: string;
  serialBackend: string;
  browserBackend: string;
  nativeBackend: string;
  nativeHint: string;
  choosePort: string;
  loadingPorts: string;
  refreshSystemPorts: string;
  nativePortsEmpty: string;
  serialMotionTest: string;
  serialMotionDone: string;
  motionHint: string;
  stopTest: string;
  testStopped: string;
}

const TEXT: Record<string, Text> = {
  "zh-CN": {
    importTitle: "导入 funscript",
    folder: "输出目录",
    folderHint: "相对 assets/ 的子目录，例如 bgm、se",
    overwrite: "覆盖同名文件",
    choose: "选择 .funscript",
    chosen: "已选择",
    summary: "摘要",
    run: "打包并写入资产目录",
    done: "已写入",
    hint: "写入后需要在 Studio 里刷新资产才能看到；还要把该素材的打包策略设为「强制打包」，否则不会进构建。",
    noProject: "拿不到项目目录，无法写入。",
    badFolder: "输出目录只能用字母、数字、下划线、短横线和斜杠。",
    other: "其他设置",
    connTitle: "设备连接",
    mode: "连接方式",
    modeUdp: "WiFi / UDP",
    modeSerial: "USB / 蓝牙串口",
    deviceHost: "设备地址",
    devicePort: "UDP 端口",
    baudRate: "波特率",
    status: "状态",
    connHint:
      "测试会发送小幅动作并回到中位；串口测试结束后释放端口。请先断开预览中的同一设备。",
    noNode: "宿主没有提供 Node 模块加载器，无法测试。",
    testConn: "测试设备",
    testing: "测试中…",
    testOk: "测试动作已发送（请看设备是否动作）",
    testReply: "设备回复",
    testNoReply: "没有响应",
    testSerialHint: "这个窗口没有 Web Serial，串口测试不可用；请改用 UDP，或用预览/游戏连接。",
    testNoReplyDetail: "端口已打开，但固件没有返回身份信息。试动指令仍已发送，请观察动作并确认波特率。",
    notTested: "未测试",
    portLabel: "串口",
    portRefresh: "刷新",
    portGrant: "添加串口…",
    portEmpty: "还没有已授权的串口；点「添加串口…」在系统对话框里选一个。",
    portNoApi: "这个窗口没有 Web Serial，串口不可用。",
    portInactive: "当前是 UDP 模式；切到「USB / 蓝牙串口」后选择设备。",
    grantFailed: "添加串口失败",
    serialType: "串口类型",
    serialAuto: "自动识别",
    serialBluetooth: "传统蓝牙 SPP",
    bluetoothHint: "蓝牙请先在系统中配对；仅 BLE 的设备暂不支持。授权只对当前窗口有效，玩家仍需自行授权。",
    serialOk: "串口已打开并完成身份查询",
    serialBackend: "串口访问方式",
    browserBackend: "浏览器授权",
    nativeBackend: "桌面原生串口",
    nativeHint: "选择系统串口后可测试。测试会让 L0 轴缓慢回到中位、小幅移动，再回到中位并停止，完成后释放端口。",
    choosePort: "请选择串口…",
    loadingPorts: "正在读取串口…",
    refreshSystemPorts: "刷新系统串口",
    nativePortsEmpty: "未找到匹配的系统串口，请检查接线、驱动及筛选条件后刷新。",
    serialMotionTest: "测试设备（小幅试动）",
    serialMotionDone: "小幅试动与回中指令已发送，请观察设备",
    motionHint: "会驱动 L0 轴：中位 50% → 60% → 50%，最后停止并释放端口。",
    stopTest: "停止测试",
    testStopped: "测试已停止",
  },
  "en-US": {
    importTitle: "Import funscript",
    folder: "Output folder",
    folderHint: "Sub-folder under assets/, for example bgm or se",
    overwrite: "Overwrite existing files",
    choose: "Choose .funscript",
    chosen: "Selected",
    summary: "Summary",
    run: "Pack and write into assets",
    done: "Written",
    hint: "Refresh assets in Studio to see it, and set the asset's pack policy to force-pack, otherwise it will not be built.",
    noProject: "Cannot find the project folder, nothing was written.",
    badFolder: "The output folder may only contain letters, digits, _ , - and /.",
    other: "Other settings",
    connTitle: "Device",
    mode: "Transport",
    modeUdp: "WiFi / UDP",
    modeSerial: "USB / Bluetooth serial",
    deviceHost: "Device address",
    devicePort: "UDP port",
    baudRate: "Baud rate",
    status: "Status",
    connHint:
      "Testing sends a small motion and recenters. The serial port is released afterward. Disconnect the same device in the preview first.",
    noNode: "The host does not expose a Node module loader, so the test cannot run.",
    testConn: "Test device",
    testing: "Testing…",
    testOk: "Test motion sent (watch the device)",
    testReply: "Device replied",
    testNoReply: "No response",
    testSerialHint: "This window has no Web Serial, so the serial test is unavailable; use UDP, or connect from the preview.",
    testNoReplyDetail: "The port opened without an identity reply. Motion commands were still sent; watch the device and check the baud rate.",
    notTested: "Not tested",
    portLabel: "Serial port",
    portRefresh: "Refresh",
    portGrant: "Add port…",
    portEmpty: "No serial port is authorized yet. Use {add} to pick one in the system dialog.".replace(
      "{add}",
      "Add port…",
    ),
    portNoApi: "This window has no Web Serial, so serial ports are unavailable.",
    portInactive: "Select USB / Bluetooth serial above to pick a device.",
    grantFailed: "Could not add the serial port",
    serialType: "Serial type",
    serialAuto: "Automatic",
    serialBluetooth: "Bluetooth SPP",
    bluetoothHint: "Pair Bluetooth in system settings first. BLE-only devices are not supported yet. Players must authorize their own devices.",
    serialOk: "Serial port opened; identity query completed",
    serialBackend: "Serial access",
    browserBackend: "Browser permission",
    nativeBackend: "Desktop native serial",
    nativeHint: "Select a system serial port. Testing slowly centers L0, moves it a little, recenters, then stops and releases the port.",
    choosePort: "Select a serial port…",
    loadingPorts: "Loading serial ports…",
    refreshSystemPorts: "Refresh system serial ports",
    nativePortsEmpty: "No matching system port. Check wiring, drivers and filters, then refresh.",
    serialMotionTest: "Test device (small motion)",
    serialMotionDone: "Small-motion and recenter commands sent; watch the device",
    motionHint: "Moves L0: center 50% → 60% → 50%, then stops and releases the port.",
    stopTest: "Stop test",
    testStopped: "Test stopped",
  },
};

function useText(): Text {
  const locale = useStudioLocale();
  return TEXT[locale] ?? TEXT["zh-CN"];
}

/** 宿主注入的项目目录（编辑器页面里唯一可靠的项目路径来源）。 */
function projectDir(): string | null {
  const value = (globalThis as unknown as { __avgVisualUIProjectDir__?: unknown })
    .__avgVisualUIProjectDir__;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 按 Studio 的素材命名规则清洗，避免写出 Windows 不允许的名字。 */
function sanitizeName(name: string): string {
  return (
    name
      .replace(/[%#?<>:"/\\|*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "_")
      .trim() || "script"
  );
}

function FolderRow() {
  const text = useText();
  const [folder, setFolder] = useSetting<string>("osr6.scriptImportFolder");
  return (
    <Row label={text.folder} description={text.folderHint}>
      <Input
        value={folder ?? "bgm"}
        onChange={setFolder}
        placeholder="bgm"
        ariaLabel={text.folder}
      />
    </Row>
  );
}

function OverwriteRow() {
  const text = useText();
  const [overwrite, setOverwrite] = useSetting<boolean>("osr6.scriptImportOverwrite");
  return (
    <Row label={text.overwrite}>
      <Toggle
        checked={overwrite === true}
        onChange={setOverwrite}
        ariaLabel={text.overwrite}
      />
    </Row>
  );
}

interface Picked {
  fileName: string;
  text: string;
  actions: number;
  durationMs: number;
  wavBytes: number;
}

function ImportSection() {
  const text = useText();
  const [folder] = useSetting<string>("osr6.scriptImportFolder");
  const [overwrite] = useSetting<boolean>("osr6.scriptImportOverwrite");
  const [picked, setPicked] = useState<Picked | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  async function onPick(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      const script = parseFunscript(raw);
      const wav = encodeCarrierWav(raw);
      setPicked({
        fileName: file.name,
        text: raw,
        actions: script.actions.length,
        durationMs: script.durationMs,
        wavBytes: wav.length,
      });
      toast({ title: text.chosen + "：" + file.name, type: "info" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      toast({ title: "解析失败", description: reason, type: "error" });
      setPicked(null);
    } finally {
      event.target.value = "";
    }
  }

  function runImport() {
    if (!picked) return;

    const root = projectDir();
    if (!root) {
      toast({ title: text.noProject, type: "error" });
      return;
    }

    const sub = (folder ?? "bgm").trim().replace(/^\/+|\/+$/g, "");
    if (!/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(sub)) {
      toast({ title: text.badFolder, description: sub, type: "error" });
      return;
    }

    // 模块名写成字面量、直接调用宿主 require（工坊机械审核不接受别名转发）
    const host = globalThis as unknown as { require?: (id: string) => unknown };
    const fs =
      typeof host.require === "function"
        ? (host.require("fs") as {
            existsSync: (p: string) => boolean;
            mkdirSync: (p: string, options: { recursive: boolean }) => void;
            writeFileSync: (p: string, data: Uint8Array) => void;
          })
        : null;
    const path =
      typeof host.require === "function"
        ? (host.require("path") as { join: (...parts: string[]) => string })
        : null;
    if (!fs || !path) {
      toast({ title: "宿主没有提供文件系统访问", type: "error" });
      return;
    }

    try {
      const dir = path.join(root, "assets", sub);
      fs.mkdirSync(dir, { recursive: true });

      const base = sanitizeName(picked.fileName.replace(/\.funscript$/i, ""));
      let target = path.join(dir, base + ".wav");
      if (overwrite !== true) {
        let index = 2;
        while (fs.existsSync(target)) {
          target = path.join(dir, base + "-" + index + ".wav");
          index += 1;
        }
      }

      fs.writeFileSync(target, encodeCarrierWav(picked.text));

      const relative = "assets/" + (sub ? sub + "/" : "") + target.split(/[\\/]/).pop();
      toast({ title: text.done + "：" + relative, description: text.hint, type: "success" });
      setPicked(null);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      toast({ title: "写入失败", description: reason, type: "error" });
    }
  }

  return (
    <Card title={text.importTitle}>
      <Row label={text.choose} description={text.hint}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            ref={inputRef}
            type="file"
            accept=".funscript,application/json"
            style={{ display: "none" }}
            onChange={onPick}
          />
          <Btn onClick={() => inputRef.current?.click()}>{text.choose}</Btn>
          {picked ? (
            <span style={{ color: COLORS.textMuted, fontSize: TYPE.hint }}>
              {text.chosen}：{picked.fileName}
            </span>
          ) : null}
        </div>
      </Row>

      {picked ? (
        <>
          <Row label={text.summary}>
            <span style={{ color: COLORS.textMuted, fontSize: TYPE.hint }}>
              {picked.actions} 个动作点 · {(picked.durationMs / 1000).toFixed(1)} s · WAV{" "}
              {picked.wavBytes} B
            </span>
          </Row>
          <Row label="">
            <Btn tone="primary" onClick={runImport}>{text.run}</Btn>
          </Row>
        </>
      ) : null}
    </Card>
  );
}


/** 连接方式选择：直接写项目设置，和运行时读的是同一个字段。 */
function TransportRow({ disabled = false }: { disabled?: boolean }) {
  const text = useText();
  const [transport, setTransport] = useSetting<string>("osr6.transport");
  return (
    <Row label={text.mode}>
      <Segmented
        value={transport === "serial" ? "serial" : "udp"}
        onChange={setTransport}
        options={[
          { value: "udp", label: text.modeUdp },
          { value: "serial", label: text.modeSerial },
        ]}
        ariaLabel={text.mode}
        disabled={disabled}
      />
    </Row>
  );
}

interface ProbeResult {
  ok: boolean;
  detail: string;
  motion?: boolean;
  cancelled?: boolean;
}

/**
 * UDP 测试：**发动作**，不靠回包判断。
 *
 * 实测这台「赛博电子姬-ESP32」固件（TCode v0.3，SR6/OSR6 模式）收到 `D0`
 * 不会回包，但位置指令照常执行——所以"等回包"会把正常的设备判成失败。
 * 现在改成发一组小幅动作（L0 0.5 → 0.65 → 0.5，带爬升），由创作者看设备确认。
 *
 * 顺手仍然发一条 `D0`：万一固件会回包，就把身份信息一起显示出来。
 */
async function probeUdp(host: string, port: number, signal: AbortSignal): Promise<ProbeResult> {
  // 模块名写成字面量、直接调用宿主 require（工坊机械审核不接受别名转发）
  const host_ = globalThis as unknown as { require?: (id: string) => unknown };
  if (typeof host_.require !== "function") {
    return { ok: false, detail: "" };
  }
  const dgram = host_.require("node:dgram") as UdpProbeModule;
  return probeUdpDevice({ host, port, signal, dgram });
}

/** 宿主有 Node（桌面 Studio / 桌面游戏）就用系统串口，浏览器里退回 Web Serial。 */
function hostSupportsNativeSerial(): boolean {
  return typeof (globalThis as unknown as { require?: unknown }).require === "function";
}

/** 浏览器和原生串口共用选择控件；设备必须由用户明确选择。 */
function SerialPortRow({ onSelect, getNativeApi, disabled = false }: {
  onSelect: (port: SerialPortLike | undefined) => void;
  getNativeApi: () => SerialApiLike;
  disabled?: boolean;
}) {
  const text = useText();
  const [transport] = useSetting<string>("osr6.transport");
  // 作者不需要选访问方式：自动按宿主能力判定。
  const native = hostSupportsNativeSerial();
  const active = transport === "serial";
  const [kind, setKind] = useSetting<string>("osr6.serialKind");
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof listSerialDevices>>>([]);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = useRef<SerialPortLike>();
  const mounted = useRef(true);
  const generation = useRef(0);
  const options = (): SerialOptions => ({
    api: native ? getNativeApi() : undefined,
    baudRate: 115200, kind: serialKind(kind),
  });
  function select(port: SerialPortLike | undefined, index?: number) {
    chosen.current = port;
    setChoice(index === undefined ? "" : String(index));
    onSelect(port);
    // Device selection is local to this mounted panel. Persisting the legacy
    // list index makes Studio reload the page and lose the selected port object.
  }
  async function refresh() {
    const current = ++generation.current;
    setBusy(true);
    try {
      const result = await listSerialDevices(options());
      if (mounted.current && current === generation.current) {
        setDevices(result); setError("");
        const selected = result.find((item) => item.port === chosen.current);
        if (!selected) select(undefined);
        else setChoice(String(selected.index));
      }
    } catch (cause) {
      if (mounted.current && current === generation.current) {
        setDevices([]); setError(errorMessage(cause)); select(undefined);
      }
    } finally {
      if (mounted.current && current === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++generation.current; };
  }, []);
  useEffect(() => {
    select(undefined);
    if (active) void refresh();
    else { setDevices([]); ++generation.current; setBusy(false); }
  }, [kind, native, active]);
  async function grant() {
    setBusy(true);
    try {
      const port = await requestSerialDevice(options());
      if (!mounted.current) return;
      const result = await listSerialDevices(options());
      if (!mounted.current) return;
      const selected = result.find((item) => item.port === port);
      setDevices(result);
      if (selected) select(port, selected.index);
      setError("");
    } catch (cause) {
      if (mounted.current) setError(serialRequestErrorMessage(cause));
    } finally { if (mounted.current) setBusy(false); }
  }
  const reason = native ? null : serialUnavailableReason();
  return <>
    {/* 串口类型由外层 DeviceSection 渲染（那里能按连接方式整体显隐） */}
    <Row label={text.portLabel} description={!active ? text.portInactive : reason ?? undefined}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Dropdown value={choice} placeholder={busy ? text.loadingPorts : text.choosePort}
          onChange={(value) => {
            const selected = devices.find((item) => item.index === Number(value));
            if (selected) select(selected.port, selected.index);
          }}
          options={devices.map((item) => ({ value: String(item.index), label: item.label }))}
          ariaLabel={text.portLabel} disabled={!active || busy || disabled || !!reason || devices.length === 0} />
        <Btn onClick={() => void refresh()} disabled={!active || !!reason || busy || disabled}>
          {native ? text.refreshSystemPorts : text.portRefresh}
        </Btn>
        {!native ? <Btn onClick={() => void grant()} disabled={!active || !!reason || busy || disabled}>{text.portGrant}</Btn> : null}
        {!busy && !devices.length && !error ? <Value>
          {reason ?? (native ? text.nativePortsEmpty : text.portEmpty)}
        </Value> : null}
        {error ? <span role="alert" style={{ fontSize: TYPE.hint, color: "#e08a8a" }}>{error}</span> : null}
      </div>
    </Row>
  </>;
}

function DeviceSection() {
  const text = useText();
  const [transport] = useSetting<string>("osr6.transport");
  const [host, setHost] = useSetting<string>("osr6.udpHost");
  const [port, setPort] = useSetting<number>("osr6.udpPort");
  const [baudRate, setBaudRate] = useSetting<number>("osr6.baudRate");
  const [kind, setKind] = useSetting<string>("osr6.serialKind");
  // 访问方式自动判定，不再作为作者选项；游戏运行时也会按同一规则回落。
  const native = hostSupportsNativeSerial();
  const backend: string = native ? "native" : "web";
  const [selectedPort, setSelectedPort] = useState<SerialPortLike>();
  const nativeApi = useRef<NativeSerialApi>();
  function getNativeApi(): NativeSerialApi {
    if (!nativeApi.current) nativeApi.current = createStudioSerialApi();
    return nativeApi.current;
  }
  const testAbort = useRef<AbortController | null>(null);
  const testTask = useRef<Promise<ProbeResult> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => () => {
    testAbort.current?.abort();
    const api = nativeApi.current;
    nativeApi.current = undefined;
    // 让试动的取消清理先发送停止并释放端口，再销毁串口会话。
    if (testTask.current) void testTask.current.catch(() => undefined).finally(() => api?.dispose());
    else api?.dispose();
  }, [backend, transport]);

  const [busy, setBusy] = useState(false);
  const configuration = JSON.stringify([transport, backend, host, port, baudRate, kind]);
  const currentSelection = useRef({ configuration, selectedPort });
  currentSelection.current = { configuration, selectedPort };
  const [outcome, setOutcome] = useState<{
    configuration: string; selectedPort?: SerialPortLike; result: ProbeResult;
  } | null>(null);
  const result = outcome?.configuration === configuration && outcome.selectedPort === selectedPort ? outcome.result : null;
  useEffect(() => {
    setOutcome(null);
    return () => { testAbort.current?.abort(); };
  }, [configuration, selectedPort]);

  const endpoint =
    transport === "serial"
      ? (selectedPort ? describeSerialPort(selectedPort) : "未选择串口") + " @ " + (baudRate ?? 115200)
      : (host ?? "192.168.1.1") + ":" + (port ?? 8000);

  async function test() {
    if (testAbort.current) return;
    if (transport === "serial" && !selectedPort) return;
    setBusy(true);
    setOutcome(null);
    const controller = new AbortController();
    testAbort.current = controller;
    const publish = (result: ProbeResult) => {
      if (!mounted.current || testAbort.current !== controller ||
          currentSelection.current.configuration !== configuration || currentSelection.current.selectedPort !== selectedPort) return false;
      setOutcome({ configuration, selectedPort, result });
      return true;
    };
    let task: Promise<ProbeResult> | undefined;
    try {
      task =
        transport === "serial"
          ? testSerialDevice({
            api: serialBackend(backend) === "native" ? getNativeApi() : undefined,
            baudRate: Math.round(baudRate ?? 115200), kind: serialKind(kind), selectedPort,
          }, controller.signal)
          : probeUdp((host ?? "").trim() || "192.168.1.1", Math.round(port ?? 8000), controller.signal);
      testTask.current = task;
      const probe = await task;
      if (!publish(probe) || probe.cancelled) return;

      // 把这几种"不是设备的问题"的情况翻成人话
      let detail = probe.detail;
      if (detail === "no-serial-api") {
        detail = text.testSerialHint;
      } else if (detail === "connected-no-reply") {
        detail = text.testNoReplyDetail;
      } else if (detail === "sent") {
        detail = "";
      } else if (detail.startsWith("reply:")) {
        detail = text.testReply + "：" + detail.slice(6);
      }

      toast({
        title: probe.ok ? (probe.motion ? text.serialMotionDone : transport === "serial" ? text.serialOk : text.testOk) : text.testNoReply,
        description: detail || undefined,
        type: probe.ok ? "success" : "warning",
      });
    } catch (error) {
      publish({ ok: false, detail: errorMessage(error), cancelled: controller.signal.aborted });
    } finally {
      if (testAbort.current === controller) {
        testAbort.current = null;
        if (mounted.current) setBusy(false);
      }
      if (testTask.current === task) testTask.current = null;
    }
  }

  const rawDetail = result?.detail ?? "";
  const shownDetail =
    rawDetail === "no-serial-api"
      ? text.testSerialHint
      : rawDetail === "connected-no-reply"
        ? text.testNoReplyDetail
        : rawDetail === "sent"
          ? ""
          : rawDetail.startsWith("reply:")
            ? text.testReply + "：" + rawDetail.slice(6)
            : rawDetail;

  const statusText = busy
    ? text.testing
    : result === null
      ? text.notTested
      : (result.cancelled ? text.testStopped : result.ok ? (result.motion ? text.serialMotionDone : transport === "serial" ? text.serialOk : text.testOk) : text.testNoReply) +
        (shownDetail ? "：" + shownDetail : "");

  const numberInput = (
    raw: string,
    apply: (value: number) => void,
    min: number,
    max: number,
  ) => {
    const next = Number(raw);
    if (Number.isFinite(next)) apply(Math.min(max, Math.max(min, Math.round(next))));
  };

  return (
    <Card title={text.connTitle}>
      <TransportRow disabled={busy} />
      {transport === "serial" ? (
        <>
          <Row label={text.serialType} description={native ? text.nativeHint : text.bluetoothHint} disabled={busy}>
            <Segmented value={serialKind(kind)} onChange={setKind} options={[
              { value: "auto", label: text.serialAuto }, { value: "usb", label: "USB" },
              { value: "bluetooth", label: text.serialBluetooth },
            ]} ariaLabel={text.serialType} disabled={busy} />
          </Row>
          <SerialPortRow onSelect={setSelectedPort} getNativeApi={getNativeApi} disabled={busy} />
          <Row label={text.baudRate} disabled={busy}>
            <Input value={String(baudRate ?? 115200)} ariaLabel={text.baudRate} disabled={busy}
              onChange={(value) => numberInput(value, setBaudRate, 1200, 921600)} />
          </Row>
        </>
      ) : (
        <>
          <Row label={text.deviceHost} disabled={busy}>
            <Input value={host ?? ""} ariaLabel={text.deviceHost} placeholder="192.168.1.1" disabled={busy}
              onChange={(value) => setHost(value)} />
          </Row>
          <Row label={text.devicePort} disabled={busy}>
            <Input value={String(port ?? 8000)} ariaLabel={text.devicePort} disabled={busy}
              onChange={(value) => numberInput(value, setPort, 1, 65535)} />
          </Row>
        </>
      )}
      <Row label={text.status} description={text.connHint}>
        <Value>
          {endpoint} · {statusText}
        </Value>
      </Row>
      <Row label="" description={transport === "serial" ? text.motionHint : undefined}>
        <Btn tone="primary" onClick={test} disabled={busy || (transport === "serial" && !selectedPort)}>
          {busy ? text.testing : transport === "serial" ? text.serialMotionTest : text.testConn}
        </Btn>
        {busy ? <Btn tone="danger" disabled={testAbort.current?.signal.aborted === true}
          onClick={() => {
            testAbort.current?.abort();
            setOutcome({ configuration, selectedPort, result: { ok: false, cancelled: true, detail: text.stopTest } });
          }}>
          {text.stopTest}
        </Btn> : null}
      </Row>
    </Card>
  );
}

function SettingsPage() {
  const text = useText();
  return (
    <div>
      {/* 页头：与游戏内界面同样的「小标题 + 大标题 + 强调线」节奏，尺寸按工具面板缩放 */}
      <header style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 10, letterSpacing: 3, color: "rgba(127, 212, 200, 0.65)" }}>EXTENSION</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 2 }}>
          <h1 style={{ margin: 0, fontSize: TYPE.title, fontWeight: 600, color: COLORS.text, letterSpacing: 1 }}>
            OSR6 设备
          </h1>
          <span style={{ width: 40, height: 3, borderRadius: 2, background: COLORS.accent }} />
        </div>
      </header>
      <DeviceSection />
      <ImportSection />
      <Card title={text.other}>
        <FolderRow />
        <OverwriteRow />
      </Card>
      {/* 剩下的引擎参数交给 Studio 的自动表单：列表型设置（轴）在那里编辑更顺手 */}
      <AutoSettings
        exclude={[
          "osr6.scriptImportFolder",
          "osr6.scriptImportOverwrite",
          "osr6.transport",
          "osr6.serialKind",
          "osr6.serialBackend",
          "osr6.udpHost",
          "osr6.udpPort",
          "osr6.baudRate",
        ]}
      />
    </div>
  );
}

export const settingsPage = SettingsPage;
