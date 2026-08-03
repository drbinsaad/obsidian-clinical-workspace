import { build, context } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectDir = process.cwd();
const defaultOutDir = path.resolve(projectDir, "dist");
const outDir = process.env.CLINICAL_PLUGIN_OUTDIR
  ? path.resolve(process.env.CLINICAL_PLUGIN_OUTDIR)
  : defaultOutDir;
const watch = process.argv.includes("--watch");

// Development tooling — the synthetic data generator in particular — must never
// reach a build that could be installed in a vault holding real patient
// information. Watch builds enable it; anything else requires an explicit
// opt-in, and the false branch is removed entirely by dead-code elimination.
const devTools = watch || process.env.CLINICAL_DEV_TOOLS === "1";

await mkdir(outDir, { recursive: true });

const options = {
  entryPoints: [path.join(projectDir, "src/main.ts")],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view"],
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outfile: path.join(outDir, "main.js"),
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  define: { __DEV_TOOLS__: JSON.stringify(devTools) },
  logLevel: "info"
};

await Promise.all([
  copyFile(path.join(projectDir, "manifest.json"), path.join(outDir, "manifest.json")),
  copyFile(path.join(projectDir, "styles.css"), path.join(outDir, "styles.css"))
]);

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`Watching Clinical Workspace; output: ${outDir}`);
} else {
  await build(options);
  console.log(
    `Built Clinical Workspace: ${outDir}${devTools ? " (development tools INCLUDED — do not install in a clinical vault)" : ""}`
  );
}
