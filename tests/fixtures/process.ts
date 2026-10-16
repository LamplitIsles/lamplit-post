import { spawn } from "node:child_process";
import { until } from "./state";
/** Each process group belongs solely to this test; stdio is always drained. */
export function processFixture(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    executable?: string;
  } = {},
) {
  const child = spawn(options.executable ?? process.execPath, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let phase = "spawn";
  let out = "",
    err = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (err += b));
  child.stdin.end(options.input);
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    out: string;
    err: string;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      exit = { code, signal };
    });
    child.once("close", (code, signal) => {
      exit = { code, signal };
      resolve({ code, signal, out, err });
    });
  });
  return {
    child,
    exited,
    get out() {
      return out;
    },
    get err() {
      return err;
    },
    kill(signal: NodeJS.Signals) {
      if (child.exitCode !== null || child.signalCode) return;
      try {
        process.kill(-child.pid!, signal);
      } catch (e) {
        if ((e as any).code !== "ESRCH") throw e;
      }
    },
    phase(value: string) {
      phase = value;
    },
    async ready() {
      let value: any;
      try {
        await until(() => {
          for (const line of out.split("\n"))
            try {
              const v = JSON.parse(line);
              if (v.ready) value = v;
            } catch {}
          if (!value && exit)
            throw new Error(
              `Child exited before readiness: phase=${phase} code=${exit.code} signal=${exit.signal}`,
            );
          return value;
        }, 10000);
      } catch (error) {
        if (exit) throw error;
        throw new Error(`Child readiness stalled: phase=${phase} exited=false`);
      }
      return value;
    },
  };
}
