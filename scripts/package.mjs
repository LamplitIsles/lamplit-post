import { execFileSync } from "node:child_process";
import {
  rm,
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
execFileSync(
  "pnpm",
  [
    "--filter",
    "lamplit-post",
    "deploy",
    "--prod",
    "--legacy",
    "--offline",
    target,
  ],
  { stdio: "inherit" },
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
  package_manager: "pnpm 12.11.2",
  consumer_contract: "contracts/v1 (ef2fa54ec90630bad5b38b2768a13b7bf543dc4c)",
  database_provider: "@koishi-ce/plugin-database-sqlite 1.2.2",
  provider_patch_sha256: createHash("sha256")
    .update(
      await readFile("patches/@koishi-ce__plugin-database-sqlite@1.2.2.patch"),
    )
    .digest("hex"),
};
await writeFile(
  target + "/revision.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
const root = resolve(target),
  files = [],
  links = [];
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
    else
      files.push({
        path: name,
        bytes: (await stat(path)).size,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      });
  }
}
await inventory(root);
await writeFile(
  target + "/artifact-manifest.json",
  JSON.stringify(
    { schema_version: 1, revision, runtime: manifest.runtime, files, links },
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
