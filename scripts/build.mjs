import { build } from "esbuild";
import { parse } from "yaml";
import { readFile, mkdir } from "node:fs/promises";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await mkdir("dist", { recursive: true });
await build({
  entryPoints: { cli: "src/entry.ts", "post-plugin": "src/runtime.ts" },
  outdir: "dist",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  external: Object.keys(pkg.dependencies).filter(
    (p) => p !== "@koishi-ce/plugin-database-sqlite",
  ),
  plugins: [
    {
      name: "yaml-locales",
      setup(b) {
        b.onLoad({ filter: /\.ya?ml$/ }, async ({ path }) => ({
          contents: JSON.stringify(parse(await readFile(path, "utf8"))),
          loader: "json",
        }));
      },
    },
  ],
});
