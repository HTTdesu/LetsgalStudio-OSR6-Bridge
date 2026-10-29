// Simulates only the native addon boundary. Tests still exercise the bundled
// serialport library, its Windows binding, Node streams, and our Web Stream adapter.
export function fakeNativeAddon(rows = [{ path: "COM3", manufacturer: "USB test", pnpId: "USB\\VID_1234&PID_5678", vendorId: "1234", productId: "5678" }]) {
  const requests = [];
  const hooks = {};
  let reader;
  const incoming = [];
  let opened = false;
  const reply = (callback, ...args) => queueMicrotask(() => callback(...args));
  function pump() {
    if (!reader || !incoming.length) return;
    const { buffer, offset, length, callback } = reader;
    reader = undefined;
    const bytes = incoming.shift();
    const count = Math.min(length, bytes.length);
    bytes.copy(buffer, offset, 0, count);
    if (count < bytes.length) incoming.unshift(bytes.subarray(count));
    reply(callback, null, count);
  }
  const binding = {
    list(callback) { requests.push({ action: "list" }); reply(callback, null, rows.map((row) => ({ ...row }))); },
    open(path, options, callback) {
      const complete = () => {
        requests.push({ action: "open", path, options });
        if (opened) { reply(callback, new Error("Access denied: port busy")); return; }
        opened = true; reply(callback, null, 1);
      };
      if (hooks.open) hooks.open(complete); else complete();
    },
    read(fd, buffer, offset, length, callback) { reader = { buffer, offset, length, callback }; pump(); },
    write(fd, bytes, callback) {
      requests.push({ action: "write", data: bytes.toString("base64") });
      if (hooks.writeError) { reply(callback, hooks.writeError); return; }
      if (!opened) { reply(callback, new Error("Device disconnected")); return; }
      if (bytes.toString() === "D0\n") { incoming.push(Buffer.from("Native OSR\n")); pump(); }
      reply(callback, null);
    },
    drain(fd, callback) { reply(callback, null); },
    close(fd, callback) {
      requests.push({ action: "close" }); opened = false;
      if (reader) { reply(reader.callback, new Error("Port closed")); reader = undefined; }
      incoming.length = 0; reply(callback, null);
    },
  };
  return { binding, rows, requests, hooks, disconnect() {
    if (reader) { reply(reader.callback, new Error("Device disconnected")); reader = undefined; }
  }, get opened() { return opened; } };
}
