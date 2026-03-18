import { readFile } from "node:fs/promises";
import type { Plugin } from "esbuild";
import { defineConfig } from "tsup";

/**
 * Strips `createRequire` from CJS output so that `require()` calls for `.node`
 * binaries use Node's native `require`. This is critical for Bun `--compile`:
 * Bun can only statically embed native modules when they are loaded via the
 * native `require`, not via a `createRequire` wrapper.
 *
 * The ESM output keeps `createRequire` (injected via banner) because Node.js
 * ESM does not have a native `require`.
 */
function stripCreateRequireForCjs(): Plugin {
  return {
    name: "strip-create-require-cjs",
    setup(build) {
      if (build.initialOptions.format !== "cjs") return;

      build.onLoad({ filter: /wreq-js\.ts$/ }, async (args) => {
        let contents = await readFile(args.path, "utf8");

        // Remove the createRequire import
        contents = contents.replace(/import\s*\{\s*createRequire\s*\}\s*from\s*["']node:module["'];\n/, "");

        // Remove the `const require = createRequire(...)` assignment
        contents = contents.replace(
          /const\s+require\s*=\s*\n\s*typeof\s+import\.meta\s*!==\s*"undefined"\s*&&\s*import\.meta\.url\s*\?\s*createRequire\(import\.meta\.url\)\s*:\s*createRequire\(__filename\);\n/,
          "",
        );

        return { contents, loader: "ts" };
      });
    },
  };
}

export default defineConfig({
  entry: ["src/wreq-js.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  outExtension({ format }) {
    return format === "cjs" ? { js: ".cjs" } : { js: ".js" };
  },
  bundle: true,
  noExternal: ["./types.js", "./generated-types.js"],
  external: [/\.node$/],
  esbuildPlugins: [stripCreateRequireForCjs()],
});
