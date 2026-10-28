import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// This extension has two entries, built in two passes into the same dist/ folder
// (Studio loads each entry as one file and cannot load shared chunks):
//   vite build                -> dist/index.mjs  game runtime entry (src/index.tsx)
//   vite build --mode studio  -> dist/studio.js  Studio editor entry (src/studio.tsx)
// The package.json "build" script runs both: vite build && vite build --mode studio

// Shared packages the game runtime entry does not bundle: the same exact list as an extension
// without an editor entry. Other subpaths (such as react-dom/client) are bundled into dist/index.mjs.
const RUNTIME_EXTERNALS = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@avg-studio/sdk",
];

// Shared packages Studio provides to the editor entry. Matched by package name, so subpaths
// (such as react/jsx-runtime) count too.
const SHARED_PACKAGES = [
  "react",
  "react-dom",
  "@avg-studio/sdk",
];

// Packages only the Studio editor entry may use (subpaths included); Studio provides them at load time.
// Game runtime code must not import them.
const STUDIO_ONLY_PACKAGES = [
  "@chakra-ui/react",
  "@avg-studio/studio-ui",
];

// Packages Chakra uses internally (whole scopes). Studio has its own copy: never bundle them into the editor entry.
const STUDIO_INTERNAL_SCOPES = [
  "@emotion/",
  "@ark-ui/",
];

// True when source is pkg itself or one of its subpaths. Only package names count: "react" does not match "react-colorful".
function isPackageOrSubpath(source: string, pkg: string): boolean {
  return source === pkg || source.startsWith(`${pkg}/`);
}

function isStudioOnlyImport(source: string): boolean {
  return STUDIO_ONLY_PACKAGES.some((pkg) => isPackageOrSubpath(source, pkg));
}

// Imports the editor entry keeps external. Studio can load only the RUNTIME_EXTERNALS names and the roots of
// Chakra and the kit; other subpaths and @emotion/*, @ark-ui/* stay in the built file on purpose, so that
// Studio refuses to load the page and explains the fix instead of running a second copy.
function isStudioEntryExternal(source: string): boolean {
  return (
    SHARED_PACKAGES.some((pkg) => isPackageOrSubpath(source, pkg)) ||
    isStudioOnlyImport(source) ||
    STUDIO_INTERNAL_SCOPES.some((scope) => source.startsWith(scope))
  );
}

// The build fails as soon as game runtime code imports Chakra or the Studio UI kit (subpaths included).
function studioOnlyGuard(): Plugin {
  return {
    name: "avg-studio-only-imports",
    enforce: "pre",
    resolveId(source, importer) {
      if (isStudioOnlyImport(source)) {
        this.error(
          `${source} can only be used in src/studio.tsx (the Studio editor entry); game runtime code cannot import it (imported by ${importer ?? "an unknown file"}).`,
        );
      }
      return null;
    },
  };
}

export default defineConfig(({ mode }) => {
  const studio = mode === "studio";
  return {
    plugins: studio ? [react()] : [react(), studioOnlyGuard()],
    build: {
      lib: {
        entry: path.resolve(__dirname, studio ? "src/studio.tsx" : "src/index.tsx"),
        formats: ["es"],
        fileName: () => (studio ? "studio.js" : "index.mjs"),
      },
      rollupOptions: {
        external: studio ? isStudioEntryExternal : RUNTIME_EXTERNALS,
        // Inline dynamic import() of bundled code into the same file: Studio loads one file per entry.
        output: { inlineDynamicImports: true },
      },
      outDir: "dist",
      // Both passes share dist/: neither may empty it, or it deletes the other entry's file.
      emptyOutDir: false,
      sourcemap: true,
      minify: false,
    },
  };
});
