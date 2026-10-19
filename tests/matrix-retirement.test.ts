import { test, expect } from "vitest";
import { resolve } from "node:path";
import { processFixture } from "./fixtures/process";

for (const scenario of [
  "versions",
  "capabilities-failure",
  "capabilities-success",
  "restart",
  "restart-versions",
  "keepalive",
]) {
  test(`exact Matrix44 ${scenario}: cancellation retires native body and late SDK timers, process exits naturally`, async () => {
    const child = processFixture([
      resolve("tests/fixtures/matrix-retirement.mjs"),
      scenario,
    ]);
    let timer: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([
        child.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Error("Owned SDK did not exit naturally after cancellation"),
              ),
            2500,
          );
        }),
      ]);
      expect(result.code).toBe(0);
      const signal = JSON.parse(result.out.trim().split("\n").at(-1)!);
      expect(signal.nativeJobs).toBe(0);
      expect(signal.lateRequests).toBe(0);
      if (scenario === "restart-versions")
        expect(signal.capabilityRequests).toBe(1);
      if (["versions", "capabilities-failure", "keepalive"].includes(scenario))
        expect(signal.nativeAborts).toBeGreaterThan(0);
      console.info(
        JSON.stringify({
          resource: "matrix_sdk_retirement",
          ...signal,
          naturalExit: true,
        }),
      );
    } finally {
      clearTimeout(timer!);
      child.kill("SIGKILL");
      await child.exited;
    }
  });
}
