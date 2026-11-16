import { start as startRuntime } from "../../src/runtime";
import { until } from "./state";

/** Tests of connected behavior explicitly wait for the independently starting accounts. */
export async function start(...args: Parameters<typeof startRuntime>) {
  const running = await startRuntime(...args);
  try {
    await until(
      () =>
        running.service.config.accounts.every(
          (a) => running.service.platforms.get(a.id)?.ready,
        ),
      5000,
    );
    return running;
  } catch (error) {
    await running.stop();
    throw error;
  }
}
