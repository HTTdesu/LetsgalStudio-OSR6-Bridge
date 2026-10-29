import { NativeSerialApi } from "./native-serial";
import { loadSerialPort, type SerialportNodeModules } from "./serialport-loader";

interface StudioNativeHost { require?: (specifier: string) => unknown }

/**
 * 编辑器没有 ExtensionContext。为用户要求的本地设备选择和测试复用宿主 Node。
 * 只加载固定内置模块；此入口会被工坊审核标为特权，不能假定所有宿主都允许。
 */
export function createStudioSerialApi(host: StudioNativeHost = globalThis as unknown as StudioNativeHost): NativeSerialApi {
  if (typeof host.require !== "function") {
    throw new Error("当前编辑器没有开放原生串口所需的 Node 能力。请使用预览中的设备面板，或由宿主开放该能力。");
  }
  const require = host.require.bind(host);
  return new NativeSerialApi(() => loadSerialPort({
    process: require("node:process") as SerialportNodeModules["process"],
    buffer: require("node:buffer") as SerialportNodeModules["buffer"],
    fs: require("node:fs") as SerialportNodeModules["fs"],
    os: require("node:os") as SerialportNodeModules["os"],
    path: require("node:path") as SerialportNodeModules["path"],
    crypto: require("node:crypto") as SerialportNodeModules["crypto"],
    zlib: require("node:zlib") as SerialportNodeModules["zlib"],
    stream: require("node:stream") as SerialportNodeModules["stream"],
    events: require("node:events") as SerialportNodeModules["events"],
    util: require("node:util") as SerialportNodeModules["util"],
    tty: require("node:tty") as SerialportNodeModules["tty"],
    child_process: require("node:child_process") as SerialportNodeModules["child_process"],
  }));
}
