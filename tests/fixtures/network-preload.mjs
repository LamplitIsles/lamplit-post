// Owned artifact-test routing only; not part of the production artifact.
const origin = process.env.POST_TEST_PLATFORM_ORIGIN;
if (!origin) throw new Error("Owned platform origin required");
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (["bots.qq.com", "api.bot.qq.com"].includes(url.hostname))
    return original(
      new Request(new URL(url.pathname + url.search, origin), request),
    );
  if (
    url.origin !== origin &&
    url.origin !== process.env.POST_TEST_RECEIVER_ORIGIN
  )
    throw new Error("Artifact test blocked external destination");
  return original(request);
};

// Secret-free loaded-module evidence from test-owned processes only.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
if (process.env.POST_TEST_MODULE_GRAPH)
  process.once("exit", () =>
    writeFileSync(
      process.env.POST_TEST_MODULE_GRAPH,
      JSON.stringify(Object.keys(require.cache)),
    ),
  );
