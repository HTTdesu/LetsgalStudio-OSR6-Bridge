import React from "react";
import { createRoot } from "react-dom/client";
import { settings } from "./studio-ui.mjs";
import { settingsPage as SettingsPage } from "../../src/studio";
import type { UdpProbeModule } from "../../src/udp-probe";

const udpRequests: string[] = [];
function logUdp(message: string) {
  udpRequests.push(message);
  const target = document.getElementById("udp-log");
  if (target) target.textContent = "模拟 UDP 请求：" + udpRequests.join(" → ");
}
const mockUdp: UdpProbeModule = {
  createSocket() {
    logUdp("open");
    return {
      on() {},
      send(message, _port, _host, callback) {
        logUdp(message.trim());
        queueMicrotask(() => callback(null));
      },
      close() { logUdp("close"); },
    };
  },
};
(globalThis as unknown as { require: (name: string) => unknown }).require = (name) => {
  if (name === "node:dgram") return mockUdp;
  throw new Error("Unexpected fixture module: " + name);
};

function Preview() {
  const [visible, setVisible] = React.useState(true);
  return <>
    <button onClick={() => setVisible(!visible)}>{visible ? "模拟离开设置页" : "重新进入设置页"}</button>
    {visible ? <SettingsPage /> : <p>设置页已卸载，模拟请求日志保留。</p>}
  </>;
}

settings.set("osr6.transport", "serial");
settings.set("osr6.serialBackend", "windows");
settings.set("osr6.serialKind", "usb");
createRoot(document.getElementById("root")!).render(<Preview />);
