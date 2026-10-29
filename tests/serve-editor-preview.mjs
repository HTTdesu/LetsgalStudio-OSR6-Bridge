import { createServer } from "vite";
import { fileURLToPath } from "node:url";
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../", import.meta.url)),
  plugins: [{ name: "mock-editor-native-serial", enforce: "pre", resolveId(id, importer) {
    if (id === "./studio-serial" && importer?.replaceAll("\\", "/").endsWith("/src/studio.tsx")) {
      return fileURLToPath(new URL("./fixtures/studio-serial.ts", import.meta.url));
    }
  } }],
  resolve: { alias: { "@avg-studio/studio-ui": fileURLToPath(new URL("./fixtures/studio-ui.mjs", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 5187, strictPort: true },
});
await server.listen();
process.stdout.write("Editor preview: http://127.0.0.1:5187/tests/fixtures/editor-preview.html\n");
