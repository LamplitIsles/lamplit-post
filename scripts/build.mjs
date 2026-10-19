import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, cp } from "node:fs/promises";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await mkdir("dist", { recursive: true });
await build({
  entryPoints: { cli: "src/entry.ts" },
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: Object.keys(pkg.dependencies),
  loader: { ".sql": "text" },
});

execFileSync("npm", ["run", "build", "--prefix", "web"], { stdio: "inherit" });
await cp("assets/brand", "dist/web/brand", { recursive: true });
