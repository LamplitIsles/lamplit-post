import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fileTypeFromBuffer } from "file-type";
import { loadConfig, privateFile } from "./config";
import { Store } from "./store";
import { Application } from "./runtime";
import { Settings } from "./settings";
import { serveSettings } from "./management";
import { provisionAdmin } from "./admin";
const help = `Lamplit Post v1 (Node 24)
post <command> --config FILE
  admin-provision   Read administrator password from stdin (12+ characters), offline
  config-check      Validate one Post TOML document without creating state
  credential-put --ref REF --account ID --kind platform|receiver
                    Read secret from stdin; store authenticated ciphertext offline
  token-issue --agent ID    Print one new machine-agent token, replacing previous token
  token-revoke --agent ID   Revoke machine-agent token offline
  status            Inspect safe offline state; refuses serving lock
  serve             Run until SIGINT/SIGTERM; drain actual I/O before releasing ownership
post asset-upload --url BASE --file FILE
  POST_TOKEN_FILE (private) or POST_TOKEN supplies auth, never argv
All mutation/status commands refuse a serving data-directory owner.
`;
export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || command === "--help" || command === "help") {
    if (argv.length > 1) throw new Error("Invalid arguments");
    process.stdout.write(help);
    return;
  }
  const { values: v } = parseArgs({
    args: argv.slice(1),
    options: Object.fromEntries(
      ["config", "ref", "account", "kind", "agent", "url", "file"].map((k) => [
        k,
        { type: "string" as const },
      ]),
    ),
    strict: true,
  });
  const allowed: Record<string, string[]> = {
    "config-check": ["config"],
    serve: ["config"],
    status: ["config"],
    "admin-provision": ["config"],
    "credential-put": ["config", "ref", "account", "kind"],
    "token-issue": ["config", "agent"],
    "token-revoke": ["config", "agent"],
    "asset-upload": ["url", "file"],
  };
  if (
    !allowed[command] ||
    Object.keys(v).some((key) => !allowed[command].includes(key))
  )
    throw new Error("Invalid arguments");
  if (command === "asset-upload") {
    if (!v.url || !v.file) throw new Error("Upload URL/file required");
    const base = new URL(v.url);
    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error("Invalid Post URL");
    let token = process.env.POST_TOKEN;
    if (process.env.POST_TOKEN_FILE) {
      await privateFile(process.env.POST_TOKEN_FILE);
      token = (await readFile(process.env.POST_TOKEN_FILE, "utf8")).trim();
    }
    if (!token) throw new Error("Token required");
    const bytes = await readFile(v.file),
      detected = await fileTypeFromBuffer(bytes).catch(() => undefined);
    const response = await fetch(new URL("/assets", base), {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": detected?.mime ?? "application/octet-stream",
        "X-Post-Filename": v.file.split("/").pop()!,
      },
      body: bytes,
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (response.status !== 201) throw new Error("Upload rejected");
    console.log(JSON.stringify(await response.json()));
    return;
  }
  if (!v.config) throw new Error("Config required");
  if (command.startsWith("token-") && !v.agent)
    throw new Error("Agent required");
  if (
    command === "credential-put" &&
    (!v.ref || !v.account || !["platform", "receiver"].includes(v.kind ?? ""))
  )
    throw new Error("Credential fields required");
  const config = await loadConfig(v.config);
  if (v.agent && !config.bindings.some((b) => b.agent_id === v.agent))
    throw new Error("Agent not configured");
  if (command === "config-check") {
    console.log(JSON.stringify({ valid: true }));
    return;
  }
  if (command === "admin-provision") {
    if (!config.settings || process.stdin.isTTY)
      throw new Error("Settings/stdin required");
    const store = await Store.open(config);
    try {
      let password = "";
      for await (const chunk of process.stdin) {
        password += chunk.toString();
        if (password.length > 1024) throw new Error("Password length");
      }
      await provisionAdmin(config.settings.admin_file, password.trim());
      console.log(JSON.stringify({ provisioned: true }));
    } finally {
      await store.close();
    }
    return;
  }
  if (command === "serve") {
    process.umask(0o077);
    const app = config.settings
      ? new Settings(v.config, config)
      : new Application(config);
    let management: Awaited<ReturnType<typeof serveSettings>> | undefined;
    const retire = async () => {
      const managementStopped = management?.stop();
      await app.stop();
      await managementStopped;
    };
    let stopping = false;
    const stop = () => {
      stopping = true;
      void retire().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await app.start();
      if (app instanceof Settings && !stopping)
        management = await serveSettings(app);
      if (stopping) await retire();
      if (!stopping) {
        const runtime = app instanceof Settings ? app.app : app;
        const status = await runtime.service!.status();
        console.log(
          JSON.stringify({
            ready: !!runtime.http && status.healthy,
            ...(management ? { settings_ready: true } : {}),
            url: runtime.http?.url ?? null,
            status,
          }),
        );
      }
    } catch (e) {
      await retire();
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      if (!stopping) throw e;
    }
    return;
  }
  let secret = "";
  if (command === "credential-put") {
    const matched =
      v.kind === "platform"
        ? config.accounts.some(
            (a) => a.id === v.account && a.credential === v.ref,
          )
        : config.bindings.some(
            (b) => b.id === v.account && b.receiver_credential === v.ref,
          );
    if (!matched || process.stdin.isTTY)
      throw new Error(
        "Credential reference is not configured or stdin unavailable",
      );
    for await (const chunk of process.stdin) {
      secret += chunk.toString();
      if (secret.length > 16384) throw new Error("Invalid secret");
    }
    secret = secret.trim();
    if (!secret) throw new Error("Invalid secret");
  }
  const store = await Store.open(config);
  try {
    if (command === "credential-put") {
      await store.putSecret(v.ref!, v.account!, v.kind!, secret);
      console.log(JSON.stringify({ saved: true }));
    } else if (command === "token-issue")
      console.log(await store.issue(v.agent!));
    else if (command === "token-revoke") {
      await store.revoke(v.agent!);
      console.log(JSON.stringify({ revoked: true }));
    } else
      console.log(
        JSON.stringify({
          accounts: store.db
            .prepare("SELECT account,platform,native FROM identities")
            .all(),
          deliveries: ["pending", "held", "accepted", "cancelled"].map(
            (state) => ({
              state,
              count: (
                store.db
                  .prepare("SELECT count(*) n FROM deliveries WHERE state=?")
                  .get(state) as { n: number }
              ).n,
            }),
          ),
          gaps: store.db
            .prepare("SELECT * FROM gaps ORDER BY seq DESC LIMIT 20")
            .all(),
        }),
      );
  } finally {
    await store.close();
  }
}
