import { build } from "vite";

await Promise.all([
  build({ build: { watch: {} } }),
  build({ mode: "studio", build: { watch: {} } }),
]);
