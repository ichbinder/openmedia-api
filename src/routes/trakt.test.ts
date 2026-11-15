import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const getEntry = vi.fn();
vi.mock("../lib/config-service.js", async (orig) => ({
  ...(await orig<object>()),
  getEntry: (...a: unknown[]) => getEntry(...a),
}));

import { createApp } from "../app.js";

const app = createApp();
const CLIENT_ID = "client-id-secret";
const TOKEN = "access-token-secret";
const reply = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe("/trakt", () => {
  let auth: { Authorization: string };
  let fetchMock: ReturnType<typeof vi.fn>;
  let routes: Record<string, () => ReturnType<typeof reply>>;

  const calls = (path: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(path));

  beforeEach(async () => {
    const res = await request(app).post("/auth/register").send({ email: "trakt@test.de", password: "test123", name: "T" });
    auth = { Authorization: `Bearer ${res.body.token}` };
    getEntry.mockReset();
    getEntry.mockResolvedValue({ value: CLIENT_ID });
    routes = {
      "/oauth/device/code": () => reply(200, { device_code: "dev", user_code: "ABCD", verification_url: "https://trakt.tv/activate", expires_in: 600, interval: 5 }),
      "/oauth/device/token": () => reply(400),
      "/oauth/revoke": () => reply(200),
      "/sync/ratings/movies": () => reply(200, [{ rating: 9, movie: { ids: { tmdb: 1 } } }]),
      "/sync/ratings/shows": () => reply(200, []),
      "/sync/watched/movies": () => reply(200, [{ movie: { ids: { tmdb: 2 } } }]),
      "/sync/watched/shows": () => reply(200, []),
    };
    fetchMock = vi.fn(async (url: string) => routes[new URL(url).pathname]());
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  const connect = () => request(app).post("/trakt/connect").set(auth);
  const poll = () => request(app).post("/trakt/poll").set(auth);

  it("ohne Client-ID: 503", async () => {
    getEntry.mockResolvedValue(null);
    const res = await connect();
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Trakt ist nicht eingerichtet." });
  });

  it("connect sendet client_id ohne Secret und gibt keinen deviceCode zurück", async () => {
    const res = await connect();
    expect(res.body).toEqual({ userCode: "ABCD", verificationUrl: "https://trakt.tv/activate", expiresIn: 600, interval: 5 });
    const [, init] = calls("/oauth/device/code")[0];
    expect(JSON.parse(init.body)).toEqual({ client_id: CLIENT_ID });
    expect(init.headers).toMatchObject({ "trakt-api-version": "2", "trakt-api-key": CLIENT_ID, "User-Agent": "openmedia/1.0" });
  });

  it("poll ohne connect: expired", async () => {
    expect((await poll()).body).toEqual({ status: "expired" });
  });

  it("400 pending, 418 denied (Eintrag danach gelöscht)", async () => {
    await connect();
    expect((await poll()).body).toEqual({ status: "pending" });
    routes["/oauth/device/token"] = () => reply(418);
    expect((await poll()).body).toEqual({ status: "denied" });
    expect((await poll()).body).toEqual({ status: "expired" });
  });

  it("200: importiert, widerruft, loggt kein Token; zweites poll expired", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    routes["/oauth/device/token"] = () => reply(200, { access_token: TOKEN });
    await connect();
    const res = await poll();
    expect(res.body).toEqual({ status: "done", counts: { rated: 1, seen: 1, skipped: 0 } });
    expect(calls("/oauth/revoke")).toHaveLength(1);
    expect(JSON.parse(calls("/oauth/revoke")[0][1].body)).toEqual({ token: TOKEN, client_id: CLIENT_ID });
    const logged = JSON.stringify(logs.flatMap((l) => l.mock.calls));
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(CLIENT_ID);
    expect((await poll()).body).toEqual({ status: "expired" });
    logs.forEach((l) => l.mockRestore());
  });

  it("ungültige tmdb-IDs werden übersprungen, Rest importiert; Serien-Watched ohne Staffeln", async () => {
    routes["/oauth/device/token"] = () => reply(200, { access_token: TOKEN });
    routes["/sync/ratings/movies"] = () => reply(200, [
      { rating: 9, movie: { ids: { tmdb: 0 } } },
      { rating: 9, movie: { ids: { tmdb: 1.5 } } },
      { rating: 9, movie: { ids: { tmdb: 1 } } },
    ]);
    await connect();
    const res = await poll();
    expect(res.body).toEqual({ status: "done", counts: { rated: 1, seen: 1, skipped: 2 } });
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/sync/watched/shows?extended=noseasons"))).toBe(true);
  });

  it("Fehler beim Holen: 502, Token trotzdem widerrufen", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    routes["/oauth/device/token"] = () => reply(200, { access_token: TOKEN });
    routes["/sync/ratings/movies"] = () => reply(500);
    await connect();
    const res = await poll();
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Trakt-Import fehlgeschlagen." });
    expect(calls("/oauth/revoke")).toHaveLength(1);
    const logged = JSON.stringify(err.mock.calls);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(CLIENT_ID);
    err.mockRestore();
  });
});
