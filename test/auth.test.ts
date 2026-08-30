import { describe, expect, it, vi } from "vitest";

import { createAuthProvider, fetchServerTime, requestOauth2Token } from "#/client/auth";
import { OvhApiError } from "#/client/errors";
import type { Config } from "#/config";

const baseConfig: Config = {
  endpoint: "ovh-eu",
  baseUrl: "https://eu.api.ovh.com/1.0",
  authMethod: "oauth2",
  clientId: "cid",
  clientSecret: "csecret",
  allowWrites: false,
  maxRetries: 3,
  refreshSkewSeconds: 60,
};

const signatureConfig: Config = {
  ...baseConfig,
  authMethod: "signature",
  clientId: undefined,
  clientSecret: undefined,
  applicationKey: "AK",
  applicationSecret: "AS_SECRET",
  consumerKey: "CK_CONSUMER",
};

const tokenResponse = (token: string, expiresIn = 3600): Response =>
  new Response(
    JSON.stringify({ access_token: token, expires_in: expiresIn, token_type: "Bearer" }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );

const request = { method: "GET", url: "https://eu.api.ovh.com/1.0/me", body: "" };

describe("requestOauth2Token", () => {
  it("posts client_credentials as a form body", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse("at-1"));
    await requestOauth2Token(
      "https://www.ovh.com/auth/oauth2/token",
      "cid",
      "csecret",
      fetchImpl as unknown as typeof fetch,
    );

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://www.ovh.com/auth/oauth2/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
    expect(body.get("client_id")).toBe("cid");
    expect(body.get("client_secret")).toBe("csecret");
  });

  it("surfaces a credential hint on a 401", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
    );
    await expect(
      requestOauth2Token("https://t", "cid", "bad", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow(/OVH_CLIENT_SECRET/);
  });
});

describe("oauth2 provider", () => {
  it("caches the token across requests", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse("at-1"));
    const auth = createAuthProvider({
      config: baseConfig,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(await auth.headers(request)).toEqual({ Authorization: "Bearer at-1" });
    await auth.headers(request);
    await auth.headers(request);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    const fetchImpl = vi.fn(async () => tokenResponse("at-1"));
    const auth = createAuthProvider({
      config: baseConfig,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await Promise.all([auth.headers(request), auth.headers(request), auth.headers(request)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-authenticates ahead of expiry, using the configured skew", async () => {
    let now = 1_000_000;
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(tokenResponse("at-1", 600))
      .mockResolvedValueOnce(tokenResponse("at-2", 600));
    const auth = createAuthProvider({
      config: baseConfig,
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });

    expect(await auth.headers(request)).toEqual({ Authorization: "Bearer at-1" });
    now += 539_000; // still inside 600s - 60s skew
    expect(await auth.headers(request)).toEqual({ Authorization: "Bearer at-1" });
    now += 2_000; // now past it
    expect(await auth.headers(request)).toEqual({ Authorization: "Bearer at-2" });
  });

  it("re-authenticates after invalidate()", async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(tokenResponse("at-1"))
      .mockResolvedValueOnce(tokenResponse("at-2"));
    const auth = createAuthProvider({
      config: baseConfig,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await auth.headers(request);
    auth.invalidate();
    expect(await auth.headers(request)).toEqual({ Authorization: "Bearer at-2" });
  });

  it("refuses an endpoint that has no OAuth2 login host", () => {
    expect(() => createAuthProvider({ config: { ...baseConfig, endpoint: "kimsufi-eu" } })).toThrow(
      /no OAuth2 login host/,
    );
  });
});

describe("fetchServerTime", () => {
  it("parses the plain-text unix seconds body", async () => {
    const fetchImpl = vi.fn(async () => new Response("1700000123\n", { status: 200 }));
    expect(
      await fetchServerTime("https://eu.api.ovh.com/1.0", fetchImpl as unknown as typeof fetch),
    ).toBe(1700000123);
  });

  it("throws on a non-numeric body", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>", { status: 200 }));
    await expect(
      fetchServerTime("https://x", fetchImpl as unknown as typeof fetch),
    ).rejects.toBeInstanceOf(OvhApiError);
  });
});

const timeResponse = (seconds: number): Response => new Response(String(seconds), { status: 200 });

describe("signature provider", () => {
  it("sends the four X-Ovh-* headers", async () => {
    const fetchImpl = vi.fn(async () => timeResponse(1700000000));
    const auth = createAuthProvider({
      config: signatureConfig,
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => 1700000000_000,
    });

    const headers = await auth.headers(request);
    expect(headers["X-Ovh-Application"]).toBe("AK");
    expect(headers["X-Ovh-Consumer"]).toBe("CK_CONSUMER");
    expect(headers["X-Ovh-Timestamp"]).toBe("1700000000");
    expect(headers["X-Ovh-Signature"]).toBe("$1$52caefaa1a601c277697c15d0527e15f546779e6");
  });

  it("applies the clock drift from /auth/time to the signed timestamp", async () => {
    // Local clock is 90s BEHIND OVH's. Uncorrected, every signed call would fail.
    const fetchImpl = vi.fn(async () => timeResponse(1700000090));
    const auth = createAuthProvider({
      config: signatureConfig,
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => 1700000000_000,
    });

    const headers = await auth.headers(request);
    expect(headers["X-Ovh-Timestamp"]).toBe("1700000090");
    // Same signature as the in-sync case at ts=1700000090 — proving the corrected
    // timestamp, not the local one, is what gets signed.
    expect(headers["X-Ovh-Signature"]).not.toBe("$1$52caefaa1a601c277697c15d0527e15f546779e6");
  });

  it("probes /auth/time once and caches the delta", async () => {
    const fetchImpl = vi.fn(async () => timeResponse(1700000000));
    const auth = createAuthProvider({
      config: signatureConfig,
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => 1700000000_000,
    });

    await Promise.all([auth.headers(request), auth.headers(request)]);
    await auth.headers(request);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://eu.api.ovh.com/1.0/auth/time",
    );
  });

  it("re-probes the clock after invalidate() — a 401 here is usually drift", async () => {
    const fetchImpl = vi.fn(async () => timeResponse(1700000000));
    const auth = createAuthProvider({
      config: signatureConfig,
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => 1700000000_000,
    });

    await auth.headers(request);
    auth.invalidate();
    await auth.headers(request);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("accessToken provider", () => {
  it("sends the token as a bearer and never calls out", async () => {
    const fetchImpl = vi.fn();
    const auth = createAuthProvider({
      config: { ...baseConfig, authMethod: "accessToken", accessToken: "static-token" },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(await auth.headers(request)).toEqual({ Authorization: "Bearer static-token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
