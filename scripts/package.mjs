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
// The seed is a complete, writable application. The local Post package is
// discoverable by Config and remains an ordinary pnpm file dependency.
const source = JSON.parse(await readFile("package.json", "utf8"));
await mkdir(target + "/post/dist", { recursive: true });
await cp("dist/post-plugin.cjs", target + "/post/dist/post-plugin.cjs");
await rm(target + "/dist/post-plugin.cjs");
await writeFile(
  target + "/post/package.json",
  JSON.stringify(
    {
      name: "koishi-plugin-post",
      version:
        "1.0.0+" +
        execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
          encoding: "utf8",
        }).trim(),
      main: "dist/post-plugin.cjs",
      peerDependencies: { koishi: "^4.18.11" },
      koishi: {
        description: "Post identity, admission and durable delivery",
        service: { required: ["model"] },
      },
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  target + "/package.json",
  JSON.stringify(
    {
      name: "lamplit-post-app",
      private: true,
      version: "1.0.0",
      engines: { node: ">=24 <25", pnpm: ">=12.3.4 <13" },
      scripts: {
        start: "node dist/cli.cjs serve --config koishi.yml",
        "config-check": "node dist/cli.cjs config-check --config koishi.yml",
        "admin-provision":
          "node dist/cli.cjs admin-provision --config koishi.yml",
      },
      dependencies: {
        ...source.dependencies,
        "koishi-plugin-post": "file:./post",
      },
    },
    null,
    2,
  ) + "\n",
);
await writeFile(
  target + "/pnpm-workspace.yaml",
  (await readFile("pnpm-workspace.yaml", "utf8")) +
    "\n# Service start must never install dependencies or fetch a package manager.\nverifyDepsBeforeRun: false\nfrozenLockfile: false\n",
);
await cp("examples/koishi.managed.yml", target + "/koishi.yml");
execFileSync("pnpm", ["install", "--offline", "--no-frozen-lockfile"], {
  cwd: resolve(target),
  stdio: "inherit",
  env: { ...process.env, CI: "" },
});
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
  native_plugins: Object.fromEntries(
    Object.entries(source.dependencies).filter(([name]) =>
      [
        "@koishijs/plugin-market",
        "@koishijs/plugin-auth",
        "@koishijs/plugin-config",
        "@koishijs/plugin-insight",
        "@koishijs/plugin-analytics",
        "@koishijs/plugin-logger",
        "koishi-plugin-theme-vanilla",
      ].includes(name),
    ),
  ),
  integration_patches: Object.fromEntries(
    await Promise.all(
      [
        "@koishijs__plugin-market@2.11.12.patch",
        "@koishijs__client@5.30.11.patch",
        "@koishijs__plugin-console@5.30.11.patch",
        "@koishijs__plugin-logger@2.6.9.patch",
      ].map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile("patches/" + name))
          .digest("hex"),
      ]),
    ),
  ),
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
