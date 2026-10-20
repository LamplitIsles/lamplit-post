import { execFileSync } from "node:child_process";
import {
  rm,
  mkdir,
  cp,
  writeFile,
  readFile,
  readdir,
  stat,
  realpath,
  readlink,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, relative } from "node:path";
// Build-owned output only. Does not install a service or initialize Post state.
execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
const target = "dist/node-artifact";
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
const source = JSON.parse(await readFile("package.json", "utf8"));
for (const path of [
  "package.json",
  "package-lock.json",
  "patches",
  "docs",
  "deploy",
  "examples",
  "LICENSE",
])
  await cp(path, target + "/" + path, { recursive: true });
await mkdir(target + "/web");
await cp("web/package.json", target + "/web/package.json");
await mkdir(target + "/dist");
await cp("dist/cli.cjs", target + "/dist/cli.cjs");
await cp("dist/web", target + "/dist/web", { recursive: true });
await cp("examples/post.toml", target + "/post.toml");
execFileSync(
  "npm",
  ["ci", "--omit=dev", "--offline", "--no-audit", "--no-fund"],
  { cwd: resolve(target), stdio: "inherit" },
);
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const dirty = !!execFileSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
}).trim();
const manifest = {
  schema_version: 1,
  revision,
  working_tree_dirty: dirty,
  runtime: "Node " + process.versions.node,
  package_manager: "npm",
  dependencies: source.dependencies,
  sdk_patch_sha256: createHash("sha256")
    .update(await readFile("patches/matrix-js-sdk+44.0.0.patch"))
    .digest("hex"),
  satori_patch_sha256: createHash("sha256")
    .update(await readFile("patches/@satorijs+core+4.6.0.patch"))
    .digest("hex"),
  consumer_contract:
    "contracts/v1 (sha256 " +
    createHash("sha256")
      .update(await readFile("contracts/v1/index.ts"))
      .digest("hex") +
    ")",
  database_provider: "node:sqlite DatabaseSync (single connection)",
};
await writeFile(
  target + "/revision.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
const root = resolve(target),
  files = [],
  links = [],
  dependencies = [];
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name),
      name = relative(root, path);
    if (entry.isSymbolicLink()) {
      const destination = await realpath(path);
      if (destination !== root && !destination.startsWith(root + "/"))
        throw new Error("Artifact link escapes packaged resources");
      links.push({ path: name, target: await readlink(path) });
    } else if (entry.isDirectory()) await inventory(path);
    else {
      if (entry.name === "package.json" && name.startsWith("node_modules/")) {
        const pkg = JSON.parse(await readFile(path, "utf8"));
        if (
          /^(koishi(?:$|-)|@koishijs\/|@koishi-ce\/|@minatojs\/|minato$)/.test(
            pkg.name ?? "",
          )
        )
          throw new Error("Forbidden deployed dependency");
        dependencies.push({ name: pkg.name, version: pkg.version, path: name });
      }
      files.push({
        path: name,
        bytes: (await stat(path)).size,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      });
    }
  }
}
await inventory(root);
await writeFile(
  target + "/artifact-manifest.json",
  JSON.stringify(
    {
      schema_version: 1,
      revision,
      runtime: manifest.runtime,
      files,
      links,
      dependencies,
    },
    null,
    2,
  ) + "\n",
);
execFileSync("tar", [
  "-czf",
  "dist/lamplit-post-node24.tar.gz",
  "-C",
  target,
  ".",
]);
console.log(
  "Built dist/node-artifact and dist/lamplit-post-node24.tar.gz; no installation performed.",
);
