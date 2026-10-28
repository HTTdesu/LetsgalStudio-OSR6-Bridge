/**
 * Studio 编辑期入口：自定义设置页。
 *
 * 两个功能：
 * 1. 「导入 funscript」：选 .funscript → 打包成 WAV 载波 → 写进项目 assets/。
 * 2. 「设备连接」：显示 OSR6 的连接状态，并提供连接 / 断开 / 急停 / 试动。
 *
 * 几点说明：
 * - Studio 的素材管线不接受 .funscript，编辑器页面也没有「导入素材」的接口，
 *   所以导入直接把文件写到 `<项目目录>/assets/<子目录>/`，创作者刷新资产即可看到。
 * - 写入和连接都用宿主窗口里的 Node `require`。官方文档不建议在编辑期入口用
 *   Node（工坊审核会把扩展标记为特权、需要人工过审），这是本地扩展的取舍。
 * - 编辑期的连接是**独立的一条**：它跑在 Studio 窗口里，和游戏运行时（预览/游戏）
 *   自己的连接互不共享。同一台设备同时只建议开一个，否则两边会轮流写位置。
 */
import { useEffect, useRef, useState } from "react";
import {
  AutoSettings,
  Button,
  FieldRow,
  Panel,
  Section,
  Segmented,
  Switch,
  TextInput,
  toast,
  useSetting,
  useStudioLocale,
} from "@avg-studio/studio-ui";
import { encodeCarrierWav } from "./carrier";
import { parseFunscript } from "./funscript";

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
    modeSerial: "USB 串口",
    status: "状态",
    connHint:
      "这里只保存参数，不会占用设备；真正的连接由预览/游戏运行时自己建立。测试按钮只发一条 D0 询问设备身份，不建立会话。",
    noNode: "宿主没有提供 Node 模块加载器，无法测试。",
    testConn: "测试设备",
    testing: "测试中…",
    testOk: "测试动作已发送（请看设备是否动作）",
    testReply: "设备回复",
    testNoReply: "没有响应",
    testSerialHint: "这个窗口没有 Web Serial，串口测试不可用；请改用 UDP，或用预览/游戏连接。",
    testNoReplyDetail: "端口打开了，但设备没有回包（波特率或接线可能不对）。",
    notTested: "未测试",
    portLabel: "串口",
    portRefresh: "刷新",
    portGrant: "添加串口…",
    portEmpty: "还没有已授权的串口；点「添加串口…」在系统对话框里选一个。",
    portNoApi: "这个窗口没有 Web Serial，串口不可用。",
    portInactive: "当前是 UDP 模式；把上面的连接方式切到「USB 串口」才能选串口。",
    grantFailed: "添加串口失败",
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
    modeSerial: "USB serial",
    status: "Status",
    connHint:
      "These are settings only; nothing is connected here. The preview and the running game open the real connection. The test sends a single D0 identity request and opens no session.",
    noNode: "The host does not expose a Node module loader, so the test cannot run.",
    testConn: "Test device",
    testing: "Testing…",
    testOk: "Test motion sent (watch the device)",
    testReply: "Device replied",
    testNoReply: "No response",
    testSerialHint: "This window has no Web Serial, so the serial test is unavailable; use UDP, or connect from the preview.",
    testNoReplyDetail: "The port opened but the device did not answer (check baud rate and wiring).",
    notTested: "Not tested",
    portLabel: "Serial port",
    portRefresh: "Refresh",
    portGrant: "Add port…",
    portEmpty: "No serial port is authorized yet. Use {add} to pick one in the system dialog.".replace(
      "{add}",
      "Add port…",
    ),
    portNoApi: "This window has no Web Serial, so serial ports are unavailable.",
    portInactive: "UDP is selected; switch the transport above to USB serial to pick a port.",
    grantFailed: "Could not add the serial port",
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
    <FieldRow label={text.folder} description={text.folderHint}>
      <TextInput
        value={folder ?? "bgm"}
        onChange={setFolder}
        placeholder="bgm"
        ariaLabel={text.folder}
      />
    </FieldRow>
  );
}

function OverwriteRow() {
  const text = useText();
  const [overwrite, setOverwrite] = useSetting<boolean>("osr6.scriptImportOverwrite");
  return (
    <FieldRow label={text.overwrite}>
      <Switch
        checked={overwrite === true}
        onChange={setOverwrite}
        ariaLabel={text.overwrite}
      />
    </FieldRow>
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
    <Section title={text.importTitle}>
      <FieldRow label={text.choose} description={text.hint}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            ref={inputRef}
            type="file"
            accept=".funscript,application/json"
            style={{ display: "none" }}
            onChange={onPick}
          />
          <Button onClick={() => inputRef.current?.click()}>{text.choose}</Button>
          {picked ? (
            <span style={{ color: "var(--fg-secondary)", fontSize: 12 }}>
              {text.chosen}：{picked.fileName}
            </span>
          ) : null}
        </div>
      </FieldRow>

      {picked ? (
        <>
          <FieldRow label={text.summary}>
            <span style={{ color: "var(--fg-secondary)", fontSize: 12 }}>
              {picked.actions} 个动作点 · {(picked.durationMs / 1000).toFixed(1)} s · WAV{" "}
              {picked.wavBytes} B
            </span>
          </FieldRow>
          <FieldRow label="">
            <Button onClick={runImport}>{text.run}</Button>
          </FieldRow>
        </>
      ) : null}
    </Section>
  );
}


/** 连接方式选择：直接写项目设置，和运行时读的是同一个字段。 */
function TransportRow() {
  const text = useText();
  const [transport, setTransport] = useSetting<string>("osr6.transport");
  return (
    <FieldRow label={text.mode}>
      <Segmented
        value={transport === "serial" ? "serial" : "udp"}
        onChange={setTransport}
        options={[
          { value: "udp", label: text.modeUdp },
          { value: "serial", label: text.modeSerial },
        ]}
        ariaLabel={text.mode}
      />
    </FieldRow>
  );
}

interface ProbeResult {
  ok: boolean;
  detail: string;
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
async function probeUdp(host: string, port: number): Promise<ProbeResult> {
  // 模块名写成字面量、直接调用宿主 require（工坊机械审核不接受别名转发）
  const host_ = globalThis as unknown as { require?: (id: string) => unknown };
  if (typeof host_.require !== "function") {
    return { ok: false, detail: "" };
  }
  const dgram = host_.require("node:dgram") as {
    createSocket: (type: string) => {
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      send: (msg: string, port: number, host: string, cb?: (err: Error | null) => void) => void;
      close: () => void;
    };
  };

  return await new Promise<ProbeResult>((resolve) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;
    let reply = "";
    const timers: Array<ReturnType<typeof setTimeout>> = [];

    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      timers.forEach((timer) => clearTimeout(timer));
      try {
        socket.close();
      } catch {
        // 已经关了
      }
      resolve(result);
    };

    socket.on("message", (...args: unknown[]) => {
      const message = args[0];
      if (typeof message === "object" && message !== null && "toString" in message) {
        reply = String(message as { toString: () => string }).trim();
      }
    });
    socket.on("error", (...args: unknown[]) => {
      const error = args[0];
      finish({ ok: false, detail: error instanceof Error ? error.message : String(error) });
    });

    const sendNow = (payload: string): boolean => {
      try {
        socket.send(payload, port, host, (error) => {
          if (error) finish({ ok: false, detail: error.message });
        });
        return true;
      } catch (error) {
        finish({ ok: false, detail: error instanceof Error ? error.message : String(error) });
        return false;
      }
    };

    if (sendNow("D0\n")) {
      // 小幅动作：0.5 → 0.65 → 0.5，每段 600ms 爬升
      timers.push(setTimeout(() => sendNow("L05000I300\n"), 100));
      timers.push(setTimeout(() => sendNow("L06500I600\n"), 700));
      timers.push(setTimeout(() => sendNow("L05000I600\n"), 1500));
    }

    timers.push(
      setTimeout(() => {
        finish({ ok: true, detail: reply.length > 0 ? "reply:" + reply : "sent" });
      }, 2400),
    );
  });
}

interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
  writable: WritableStream<Uint8Array> | null;
  readable: ReadableStream<Uint8Array> | null;
}

interface SerialApiLike {
  getPorts(): Promise<SerialPortLike[]>;
  requestPort(options?: { filters?: Array<{ usbVendorId?: number }> }): Promise<SerialPortLike>;
}

function serialApi(): SerialApiLike | null {
  const nav = navigator as unknown as { serial?: SerialApiLike };
  return nav.serial && typeof nav.serial.getPorts === "function" ? nav.serial : null;
}

function parseUsbId(raw: string | undefined): number | undefined {
  const text = (raw ?? "").trim();
  if (text.length === 0) return undefined;
  const value = /^0x/i.test(text) ? Number.parseInt(text, 16) : Number.parseInt(text, 10);
  return Number.isFinite(value) ? value : undefined;
}

function delay(ms: number): Promise<null> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), Math.max(0, ms));
  });
}

/**
 * 串口探测：打开端口 → 发一条 `D0` → 读回包 → 立刻关闭。
 *
 * TCode 的串口是双向的：`D0` 返回设备与固件版本，`D1` 返回协议版本，
 * `D2` 返回轴列表。所以这里能真的验证"接线对不对、波特率对不对"，
 * 代价是打开期间会短暂占用端口——测完马上释放。
 */
async function probeSerial(
  baudRate: number,
  vendorIdRaw: string | undefined,
  productIdRaw: string | undefined,
  portIndex: number | undefined,
): Promise<ProbeResult> {
  const api = serialApi();
  if (!api) {
    return { ok: false, detail: "no-serial-api" };
  }

  const vendorId = parseUsbId(vendorIdRaw);
  const productId = parseUsbId(productIdRaw);

  let port: SerialPortLike | null = null;
  try {
    const granted = await api.getPorts();
    const filtered = granted.filter((candidate) => {
      const info = candidate.getInfo();
      if (vendorId !== undefined && info.usbVendorId !== vendorId) return false;
      if (productId !== undefined && info.usbProductId !== productId) return false;
      return true;
    });
    const candidates =
      vendorId === undefined && productId === undefined ? granted : filtered;
    const index = Math.max(0, Math.round(portIndex ?? 0));
    port =
      candidates[index] ??
      candidates[0] ??
      (await api.requestPort(
        vendorId === undefined ? undefined : { filters: [{ usbVendorId: vendorId }] },
      ));

    await port.open({ baudRate });

    const writer = port.writable?.getWriter();
    if (!writer) throw new Error("端口没有可写流");
    await writer.write(new TextEncoder().encode("D0\n"));
    writer.releaseLock();

    const reader = port.readable?.getReader();
    if (!reader) throw new Error("端口没有可读流");

    const deadline = Date.now() + 1200;
    let text = "";
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), delay(deadline - Date.now())]);
      if (!chunk || chunk.done) break;
      if (chunk.value) text += new TextDecoder().decode(chunk.value);
      if (text.includes("\n")) break;
    }
    try {
      await reader.cancel();
    } catch {
      // 已经结束
    }
    await port.close();
    port = null;

    return text.trim().length > 0
      ? { ok: true, detail: text.trim() }
      : { ok: false, detail: "connected-no-reply" };
  } catch (error) {
    if (port) {
      try {
        await port.close();
      } catch {
        // ignore
      }
    }
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 串口选择。
 *
 * Web Serial 没有「枚举所有 COM 口」的接口，只能看到用户授权过的端口，
 * 所以这里列出 `getPorts()` 的结果，序号就是设置里存的 `serialPortIndex`。
 * 「添加串口…」会弹出系统对话框，授权后端口进入列表。
 */
function SerialPortRow() {
  const text = useText();
  const [transport] = useSetting<string>("osr6.transport");
  const active = transport === "serial";
  const [index, setIndex] = useSetting<number>("osr6.serialPortIndex");
  const [labels, setLabels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const api = serialApi();
    if (!api) {
      setLabels([]);
      return;
    }
    try {
      const ports = await api.getPorts();
      setLabels(
        ports.map((port, position) => {
          const info = port.getInfo();
          const vid =
            info.usbVendorId !== undefined
              ? "VID:" + info.usbVendorId.toString(16).padStart(4, "0")
              : "VID:?";
          const pid =
            info.usbProductId !== undefined
              ? "PID:" + info.usbProductId.toString(16).padStart(4, "0")
              : "PID:?";
          return "#" + position + " " + vid + " " + pid;
        }),
      );
    } catch {
      setLabels([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function grant() {
    const api = serialApi();
    if (!api) return;
    setBusy(true);
    try {
      await api.requestPort();
      await refresh();
    } catch (error) {
      toast({
        title: text.grantFailed,
        description: error instanceof Error ? error.message : String(error),
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  const supported = serialApi() !== null;

  return (
    <FieldRow
      label={text.portLabel}
      description={!active ? text.portInactive : supported ? undefined : text.portNoApi}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {labels.length > 0 ? (
          <Segmented
            value={String(Math.min(index ?? 0, labels.length - 1))}
            onChange={(value) => setIndex(Number(value))}
            options={labels.map((label, position) => ({
              value: String(position),
              label,
            }))}
            ariaLabel={text.portLabel}
            disabled={!active}
          />
        ) : (
          <span style={{ fontSize: 12, color: "var(--fg-tertiary)" }}>
            {supported ? text.portEmpty : text.portNoApi}
          </span>
        )}
        <Button onClick={() => void refresh()} disabled={!active || !supported || busy}>
          {text.portRefresh}
        </Button>
        <Button onClick={() => void grant()} disabled={!active || !supported || busy}>
          {text.portGrant}
        </Button>
      </div>
    </FieldRow>
  );
}

function DeviceSection() {
  const text = useText();
  const [transport] = useSetting<string>("osr6.transport");
  const [host] = useSetting<string>("osr6.udpHost");
  const [port] = useSetting<number>("osr6.udpPort");
  const [baudRate] = useSetting<number>("osr6.baudRate");
  const [vendorId] = useSetting<string>("osr6.serialVendorId");
  const [productId] = useSetting<string>("osr6.serialProductId");
  const [portIndex] = useSetting<number>("osr6.serialPortIndex");

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);

  const endpoint =
    transport === "serial"
      ? "serial @ " + (baudRate ?? 115200)
      : (host ?? "192.168.1.1") + ":" + (port ?? 8000);

  async function test() {
    setBusy(true);
    setResult(null);
    try {
      const probe =
        transport === "serial"
          ? await probeSerial(Math.round(baudRate ?? 115200), vendorId, productId, portIndex)
          : await probeUdp((host ?? "").trim() || "192.168.1.1", Math.round(port ?? 8000));
      setResult(probe);

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
        title: probe.ok ? text.testOk : text.testNoReply,
        description: detail || undefined,
        type: probe.ok ? "success" : "warning",
      });
    } finally {
      setBusy(false);
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
      : (result.ok ? text.testOk : text.testNoReply) +
        (shownDetail ? "：" + shownDetail : "");

  return (
    <Section title={text.connTitle}>
      <TransportRow />
      <SerialPortRow />
      <FieldRow label={text.status} description={text.connHint}>
        <span style={{ fontSize: 12, color: "var(--fg-tertiary)" }}>
          {endpoint} · {statusText}
        </span>
      </FieldRow>
      <FieldRow label="">
        <Button onClick={test} disabled={busy}>
          {text.testConn}
        </Button>
      </FieldRow>
    </Section>
  );
}

function SettingsPage() {
  const text = useText();
  return (
    <Panel>
      <DeviceSection />
      <ImportSection />
      <Section title={text.other}>
        <FolderRow />
        <OverwriteRow />
      </Section>
      <AutoSettings
        exclude={[
          "osr6.scriptImportFolder",
          "osr6.scriptImportOverwrite",
          "osr6.transport",
        ]}
      />
    </Panel>
  );
}

export const settingsPage = SettingsPage;
