import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  sourcemap: "inline",
  external: ["obsidian"]
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
