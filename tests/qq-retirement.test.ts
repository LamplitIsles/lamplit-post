import { test, expect, beforeAll, afterAll } from "vitest";
import { build } from "esbuild";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { processFixture } from "./fixtures/process";

let dir: string;
beforeAll(async () => {
  // Keep external module resolution inside the checkout; every output/home is test-owned.
  await mkdir(resolve(".scratch"), { recursive: true });
  dir = await mkdtemp(resolve(".scratch/qq-retirement-test-"));
  await build({
    entryPoints: ["tests/fixtures/qq-retirement.ts"],
    outfile: join(dir, "probe.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    loader: { ".sql": "text" },
    define: {
      "import.meta.url": JSON.stringify(
        pathToFileURL(resolve("tests/fixtures/platforms.ts")).href,
      ),
    },
  });
  await build({
    entryPoints: ["tests/fixtures/qq-retirement.ts"],
    outfile: join(dir, "probe.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    loader: { ".sql": "text" },
    define: {
      "import.meta.url": JSON.stringify(
        pathToFileURL(resolve("tests/fixtures/platforms.ts")).href,
      ),
    },
  });
});
afterAll(async () => {
  await rm(dir, { recursive: true });
});

for (const scenario of [
  "scheduled",
  "prepare",
  "startup-prepare",
  "unreachable",
  "late-socket",
  "scheduled-cjs",
]) {
  test(`QQ ${scenario}: stop drains actual SDK resources before lease release`, async () => {
    const child = processFixture(
      [
        join(dir, scenario.endsWith("-cjs") ? "probe.cjs" : "probe.mjs"),
        scenario.replace("-cjs", ""),
      ],
      {
        env: {
          ...process.env,
          HOME: dir,
          XDG_CONFIG_HOME: dir,
          XDG_STATE_HOME: dir,
          XDG_DATA_HOME: dir,
          XDG_CACHE_HOME: dir,
        },
      },
    );
    let timer: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("QQ owned process failed natural exit")),
            5000,
          );
        }),
      ]);
      expect(result.code).toBe(0);
      const signals = result.out
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      console.info(
        JSON.stringify({
          resource: "qq_sdk_retirement",
          scenario,
          signals,
          naturalExit: true,
        }),
      );
      if (scenario === "late-socket") {
        expect(signals[0]).toMatchObject({
          intake: false,
          sockets: 0,
          jobs: 0,
          lease: false,
        });
      } else if (scenario === "unreachable") {
        expect(signals[0]).toMatchObject({
          failed: true,
          connections: 0,
          lease: false,
          sockets: 0,
        });
        expect(signals[0].elapsedMs).toBeLessThan(2000);
      } else {
        if (scenario.includes("prepare"))
          expect(signals[0]).toMatchObject({
            cancelled: true,
            retired: false,
            stopReturned: false,
            lease: true,
          });
        const stopped = signals.find((s) => s.stoppedMs !== undefined);
        expect(stopped).toMatchObject({ jobs: 0, sockets: 0, lease: false });
        if (scenario.includes("prepare")) expect(stopped.retired).toBe(true);
        // A scheduled 1000ms retry must not retain the process after stop.
        const exited = signals.find((s) => s.naturalExitMs !== undefined);
        expect(exited.naturalExitMs - stopped.stoppedMs).toBeLessThan(500);
      }
    } finally {
      clearTimeout(timer!);
      child.kill("SIGKILL");
      await child.exited;
    }
  });
}
