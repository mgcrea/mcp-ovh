import { describe, expect, it, vi } from "vitest";

import { staticAuthProvider, type AuthProvider } from "#/client/auth";
import { OvhApiError } from "#/client/errors";
import { buildQuery, encodeSegment, OvhClient } from "#/client/ovh";

const makeClient = (fetchImpl: ReturnType<typeof vi.fn>, auth?: AuthProvider): OvhClient =>
  new OvhClient({
    baseUrl: "https://eu.api.ovh.com/1.0",
    auth: auth ?? staticAuthProvider(),
    defaultProject: "proj",
    defaultRegion: "UK",
    maxRetries: 2,
    fetch: fetchImpl as unknown as typeof fetch,
  });

describe("buildQuery", () => {
  it("drops undefined values so `{noObjects: undefined}` isn't sent", () => {
    expect(buildQuery({ a: "1", b: undefined })).toBe("?a=1");
  });

  it("repeats a key for array values", () => {
    expect(buildQuery({ t: ["a", "b"] })).toBe("?t=a&t=b");
  });

  it("returns an empty string for an empty query", () => {
    expect(buildQuery({})).toBe("");
    expect(buildQuery(undefined)).toBe("");
  });
});

describe("encodeSegment", () => {
  it("encodes slashes — an object key is ONE path segment", () => {
    expect(encodeSegment("a/b c.txt")).toBe("a%2Fb%20c.txt");
  });
});

describe("OvhClient errors", () => {
  it("surfaces X-Ovh-QueryID, which is what OVH support asks for", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: "Forbidden", class: "Client::Forbidden" }), {
          status: 403,
          headers: { "X-Ovh-QueryID": "EU.ext-1.abc123" },
        }),
    );

    await expect(makeClient(fetchImpl).get("/me")).rejects.toMatchObject({
      status: 403,
      queryId: "EU.ext-1.abc123",
      errorClass: "Client::Forbidden",
    });
  });

  it("explains a 403 as a permission problem, not a credentials problem", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 403 }));
    await expect(makeClient(fetchImpl).get("/me")).rejects.toThrow(/ovh_whoami/);
  });

  it("hints at project/region/bucket mix-ups on a 404", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 }));
    await expect(makeClient(fetchImpl).get("/x")).rejects.toThrow(/serviceName/);
  });
});

describe("OvhClient retries", () => {
  it("refreshes credentials and retries once on a 401", async () => {
    const invalidate = vi.fn();
    const auth: AuthProvider = {
      method: "signature",
      headers: async () => ({ "X-Ovh-Signature": "$1$deadbeef" }),
      invalidate,
    };
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    expect(await makeClient(fetchImpl, auth).get("/me")).toEqual({ ok: true });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry budget and throws the real error", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(makeClient(fetchImpl).get("/me")).rejects.toBeInstanceOf(OvhApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // initial + maxRetries
  });
});

describe("OvhClient bodies", () => {
  it("serializes the body ONCE, so the signature covers the bytes actually sent", async () => {
    const seen: string[] = [];
    const auth: AuthProvider = {
      method: "signature",
      headers: async (req) => {
        seen.push(req.body);
        return {};
      },
      invalidate: () => {},
    };
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    await makeClient(fetchImpl, auth).post("/x", { a: 1 });

    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(seen[0]).toBe('{"a":1}');
    expect(init.body).toBe('{"a":1}');
  });

  it("signs the FULL url including the query string", async () => {
    const seen: string[] = [];
    const auth: AuthProvider = {
      method: "signature",
      headers: async (req) => {
        seen.push(req.url);
        return {};
      },
      invalidate: () => {},
    };
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    await makeClient(fetchImpl, auth).get("/s", { noObjects: true });

    expect(seen[0]).toBe("https://eu.api.ovh.com/1.0/s?noObjects=true");
  });

  it("returns null for an empty 200 body, not a parse error", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    expect(await makeClient(fetchImpl).put("/x", { a: 1 })).toBeNull();
  });
});

describe("project and region resolution", () => {
  it("explains how to fix a missing project", () => {
    const client = new OvhClient({ baseUrl: "https://x", auth: staticAuthProvider() });
    expect(() => client.project()).toThrow(/OVH_CLOUD_PROJECT/);
    expect(() => client.region()).toThrow(/OVH_REGION/);
  });
});
