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
  if (url.origin !== origin)
    throw new Error("Artifact test blocked external destination");
  return original(request);
};
