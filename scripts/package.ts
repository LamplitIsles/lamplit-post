import { mkdir, copyFile } from "node:fs/promises";
// Build-only packaging. Never installs a service or writes runtime state.
await mkdir("dist/artifact", { recursive: true });
const built = await Bun.build({
  entrypoints: ["src/cli.ts"],
  outdir: "dist/artifact",
  target: "bun",
  naming: "cli.js",
});
if (!built.success) throw new Error("Artifact build failed");
await Promise.all([
  copyFile("examples/post.toml", "dist/artifact/post.example.toml"),
  copyFile("deploy/lamplit-post.service", "dist/artifact/lamplit-post.service"),
  copyFile("docs/operator.md", "dist/artifact/operator.md"),
  copyFile("LICENSE", "dist/artifact/LICENSE"),
]);
await Bun.write(
  "dist/artifact/revision.json",
  JSON.stringify(
    {
      schema_version: 1,
      revision: (
        await new Response(
          Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe" }).stdout,
        ).text()
      ).trim(),
      runtime: "Bun 1.3.13",
      consumer_contract:
        "contracts/v1 (ef2fa54ec90630bad5b38b2768a13b7bf543dc4c)",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Built dist/artifact; provide the pinned Bun runtime separately. No installation performed.",
);
