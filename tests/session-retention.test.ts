import { test, expect, vi } from "vitest";
import { settingsFixture } from "./fixtures/settings";
import { serveSettings } from "../src/management";
import { Admin, provisionAdmin } from "../src/admin";
import { readFile, writeFile, stat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("administrator restores the same session after 24 hours", async () => {
  const f = await settingsFixture(true);
  let web = f.web;
  let now = Date.now();
  const issued = now;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const login = await f.login();
    const setCookie = login.headers.get("set-cookie")!;
    expect(setCookie).toContain(
      "; Path=/api; HttpOnly; SameSite=Strict; Max-Age=2592000",
    );
    expect(setCookie).not.toContain("; Secure");
    const cookie = setCookie.split(";")[0];
    const get = () =>
      fetch(f.config.settings.origin + "/api/session", {
        headers: { Cookie: cookie },
      });
    expect((await get()).status).toBe(200);
    now += 24 * 3600000;
    expect((await get()).status).toBe(200);
    await web.stop();
    web = await serveSettings(f.app);
    expect((await get()).status).toBe(200);
    now = issued + 30 * 24 * 3600000 - 1;
    const nearExpiry = await get();
    expect(nearExpiry.status).toBe(200);
    expect(nearExpiry.headers.get("set-cookie")).toBeNull();
    now++;
    expect((await get()).status).toBe(401);
  } finally {
    clock.mockRestore();
    await web.stop();
    await f.close();
  }
});

test("HTTPS origin issues a secure administrator cookie", async () => {
  const f = await settingsFixture(
    true,
    1500,
    undefined,
    undefined,
    undefined,
    (config) => ({
      ...config,
      settings: {
        ...config.settings!,
        origin: config.settings!.origin.replace("http:", "https:"),
      },
    }),
  );
  try {
    const origin = f.config.settings.origin;
    const login = await fetch(
      origin.replace("https:", "http:") + "/api/login",
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ password: "owned-fixture-password" }),
      },
    );
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toMatch(
      /; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/,
    );
  } finally {
    await f.close();
  }
});

test("retained old sessions keep their original expiry on restart", async () => {
  const f = await settingsFixture(true);
  let web = f.web;
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const login = await f.login();
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    await web.stop();
    const path = f.config.settings.admin_file;
    const record = JSON.parse(await readFile(path, "utf8"));
    record.sessions[0].expires = now + 30 * 24 * 3600000 + 1;
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    web = await serveSettings(f.app);
    const get = () =>
      fetch(f.config.settings.origin + "/api/session", {
        headers: { Cookie: cookie },
      });
    expect((await get()).status).toBe(401);
    await web.stop();
    record.sessions[0].expires--;
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    web = await serveSettings(f.app);
    expect((await get()).status).toBe(200);
    await web.stop();
    record.sessions[0].expires = now + 8 * 3600000;
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    web = await serveSettings(f.app);
    now += 8 * 3600000 - 1;
    expect((await get()).status).toBe(200);
    now++;
    expect((await get()).status).toBe(401);
  } finally {
    clock.mockRestore();
    await web.stop();
    await f.close();
  }
});

test.each([1, 2])(
  "administrator session survives normal management restart (%s)",
  async () => {
    const f = await settingsFixture(true);
    let web = f.web;
    try {
      const login = await f.login();
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const origin = f.config.settings.origin;
      const get = (value = cookie) =>
        fetch(origin + "/api/session", { headers: { Cookie: value } });
      const csrf = (await (await get()).json()).csrf;
      await web.stop();
      web = await serveSettings(f.app);
      expect((await get()).status).toBe(200);
      expect((await (await get()).json()).csrf).toBe(csrf);
      expect((await get("post_admin=forged")).status).toBe(401);
      const logout = (csrfValue: string) =>
        fetch(origin + "/api/logout", {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "Content-Type": "application/json",
            "X-Post-CSRF": csrfValue,
          },
          body: "{}",
        });

      expect((await logout("wrong")).status).toBe(401);
      expect((await logout(csrf)).status).toBe(200);
      await web.stop();
      web = await serveSettings(f.app);
      expect((await get()).status).toBe(401);
      const next = await f.login();
      const nextCookie = next.headers.get("set-cookie")!.split(";")[0];
      const contents = await readFile(f.config.settings.admin_file, "utf8");
      expect(contents).not.toContain(nextCookie.split("=")[1]);
      expect((await stat(f.config.settings.admin_file)).mode & 0o777).toBe(
        0o600,
      );
      await web.stop();
      await provisionAdmin(f.config.settings.admin_file, "new-owned-password");
      web = await serveSettings(f.app);
      expect((await get(nextCookie)).status).toBe(401);
    } finally {
      await web.stop();
      await f.close();
    }
  },
);

test("retained sessions keep absolute expiry, installation isolation and the 32-session limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "post-session-bounds-"));
  const path = join(dir, "one.json"),
    other = join(dir, "other.json");
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    await provisionAdmin(path, "owned-fixture-password");
    await provisionAdmin(other, "owned-fixture-password");
    const admin = new Admin();
    const first = (await admin.login(path, "owned-fixture-password"))!;
    const tokens = [first];
    for (let i = 1; i < 33; i++) {
      now += 60001;
      tokens.push((await admin.login(path, "owned-fixture-password"))!);
    }
    const reopened = new Admin();
    await reopened.open(path);
    expect(reopened.session(first)).toBeUndefined();
    expect(reopened.session(tokens[1]!)).toBeDefined();
    expect(JSON.parse(await readFile(path, "utf8")).sessions).toHaveLength(32);
    const another = new Admin();
    await another.open(other);
    expect(another.session(tokens[32]!)).toBeUndefined();
    const expires = admin.session(tokens[32]!)!.expires;
    now = expires - 1;
    await reopened.open(path);
    expect(reopened.session(tokens[32]!)!.expires).toBe(expires);
    now++;
    await reopened.open(path);
    for (const token of tokens) expect(reopened.session(token)).toBeUndefined();
  } finally {
    clock.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});
