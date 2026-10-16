import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig, privateFile } from "./config";
import { Store } from "./store";
import { start } from "./runtime";
const help = `Lamplit Post v1 (Bun)
post <command> --config FILE
  config-check      Validate strict TOML without creating state
  credential-put --ref REF --account ID --kind platform|receiver
                    Read secret from stdin; store authenticated ciphertext offline
  token-issue --agent ID    Print one new token, replacing previous token
  token-revoke --agent ID   Revoke token offline
  status            Inspect safe offline state; refuses serving lock
  serve             Run until SIGINT/SIGTERM
post asset-upload --url BASE --file FILE
  POST_TOKEN_FILE (private) or POST_TOKEN supplies auth, never argv
All mutation/status commands refuse a serving data-directory owner.
`;
export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(help);
    return;
  }
  const { values: v } = parseArgs({
    args: argv.slice(1),
    options: {
      config: { type: "string" },
      ref: { type: "string" },
      account: { type: "string" },
      kind: { type: "string" },
      agent: { type: "string" },
      url: { type: "string" },
      file: { type: "string" },
    },
    strict: true,
  });
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
    const file = Bun.file(v.file);
    const endpoint = new URL("/assets", base);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": file.type || "application/octet-stream",
        "X-Post-Filename": v.file.split("/").pop()!,
      },
      body: file,
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
    if (response.status !== 201) throw new Error("Upload rejected");
    process.stdout.write(JSON.stringify(await response.json()) + "\n");
    return;
  }
  if (
    ![
      "config-check",
      "credential-put",
      "token-issue",
      "token-revoke",
      "status",
      "serve",
    ].includes(command) ||
    !v.config
  )
    throw new Error("Command/config required");
  const config = await loadConfig(v.config);
  if (command === "config-check") {
    console.log(JSON.stringify({ valid: true }));
    return;
  }
  if (command === "serve") {
    const runtime = await start(config);
    console.log(
      JSON.stringify({
        ready: true,
        url: runtime.http.url,
        status: runtime.service.status(),
      }),
    );
    const statusTimer = setInterval(
      () => console.log(JSON.stringify({ status: runtime.service.status() })),
      30000,
    );
    statusTimer.unref();
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    });
    clearInterval(statusTimer);
    await runtime.stop();
    return;
  }
  const store = new Store(config);
  try {
    if (command === "credential-put") {
      if (
        !v.ref ||
        !v.account ||
        !["platform", "receiver"].includes(v.kind ?? "")
      )
        throw new Error("Credential fields required");
      const matched =
        v.kind === "platform"
          ? config.accounts.some(
              (a) => a.id === v.account && a.credential === v.ref,
            )
          : config.bindings.some(
              (b) => b.id === v.account && b.receiver_credential === v.ref,
            );
      if (!matched) throw new Error("Credential reference is not configured");
      if (process.stdin.isTTY) throw new Error("Use a private stdin pipe");
      const text = await new Response(Bun.stdin.stream()).text();
      if (!text.trim() || text.length > 16384)
        throw new Error("Invalid secret");
      store.putSecret(v.ref, v.account, v.kind!, text.trim());
      console.log(JSON.stringify({ saved: true }));
    } else if (command === "token-issue") {
      if (!v.agent) throw new Error("Agent required");
      console.log(store.issue(v.agent));
    } else if (command === "token-revoke") {
      if (!v.agent) throw new Error("Agent required");
      store.revoke(v.agent);
      console.log(JSON.stringify({ revoked: true }));
    } else
      console.log(
        JSON.stringify({
          accounts: store.db
            .query("SELECT account,platform FROM identities")
            .all(),
          deliveries: store.db
            .query("SELECT state,count(*) count FROM deliveries GROUP BY state")
            .all(),
          gaps: store.db
            .query(
              "SELECT account,category,at FROM gaps ORDER BY seq DESC LIMIT 20",
            )
            .all(),
        }),
      );
  } finally {
    store.close();
  }
}
if (import.meta.main)
  main()
    .then(() => process.exit(0))
    .catch(() => {
      console.error(
        "Post command failed: invalid input, unavailable state or locked owner. See operator guide.",
      );
      process.exit(1);
    });
