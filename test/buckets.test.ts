import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import { staticAuthProvider } from "../src/client/auth.js";
import { stripObjects, summarizeBucket } from "../src/client/shape.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";

const config: Config = {
  endpoint: "ovh-eu",
  baseUrl: "https://eu.api.ovh.com/1.0",
  authMethod: "accessToken",
  accessToken: "tok",
  cloudProject: "abcdef0123456789abcdef0123456789",
  region: "UK",
  allowWrites: true,
  maxRetries: 3,
  refreshSkewSeconds: 60,
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const connect = async (fetchImpl: ReturnType<typeof vi.fn>): Promise<Client> => {
  const { server } = createServer({
    config,
    fetch: fetchImpl as unknown as typeof fetch,
    auth: staticAuthProvider(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const urlOf = (fetchImpl: ReturnType<typeof vi.fn>, index = 0): string =>
  (fetchImpl.mock.calls[index] as unknown as [string])[0];

const PROJECT_BASE = "https://eu.api.ovh.com/1.0/cloud/project/abcdef0123456789abcdef0123456789";

describe("ovh_get_bucket", () => {
  it("always sends noObjects=true", async () => {
    // The raw endpoint embeds a deprecated array of EVERY object in the bucket.
    const fetchImpl = vi.fn(async () => jsonResponse({ name: "dev-rgis-ar" }));
    const client = await connect(fetchImpl);

    await client.callTool({ name: "ovh_get_bucket", arguments: { bucket: "dev-rgis-ar" } });

    expect(urlOf(fetchImpl)).toBe(`${PROJECT_BASE}/region/UK/storage/dev-rgis-ar?noObjects=true`);
  });

  it("strips the objects array even if the server sends it anyway", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ name: "b", objects: [{ key: "a" }, { key: "b" }], ownerId: 42 }),
    );
    const client = await connect(fetchImpl);

    const result = await client.callTool({ name: "ovh_get_bucket", arguments: { bucket: "b" } });
    const payload = JSON.parse((result.content as { text: string }[])[0]!.text);

    expect(payload).not.toHaveProperty("objects");
    expect(payload.ownerId).toBe(42);
  });
});

describe("path encoding", () => {
  it("URL-encodes a bucket name", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = await connect(fetchImpl);

    await client.callTool({ name: "ovh_get_bucket", arguments: { bucket: "my bucket" } });

    expect(urlOf(fetchImpl)).toContain("/storage/my%20bucket?");
  });

  it("encodes the slashes in an object key — OVH addresses it as ONE segment", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = await connect(fetchImpl);

    await client.callTool({
      name: "ovh_get_object",
      arguments: { bucket: "b", key: "uploads/2026/scan 01.usdz" },
    });

    expect(urlOf(fetchImpl)).toBe(
      `${PROJECT_BASE}/region/UK/storage/b/object/uploads%2F2026%2Fscan%2001.usdz`,
    );
  });

  it("encodes the key on a version path too", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = await connect(fetchImpl);

    await client.callTool({
      name: "ovh_list_object_versions",
      arguments: { bucket: "b", key: "a/b.txt" },
    });

    expect(urlOf(fetchImpl)).toContain("/object/a%2Fb.txt/version?");
  });
});

describe("region and project resolution", () => {
  it("upper-cases a lower-case region argument", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = await connect(fetchImpl);

    await client.callTool({ name: "ovh_list_buckets", arguments: { region: "gra" } });

    expect(urlOf(fetchImpl)).toBe(`${PROJECT_BASE}/region/GRA/storage`);
  });

  it("lets a per-call project override OVH_CLOUD_PROJECT", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = await connect(fetchImpl);

    await client.callTool({ name: "ovh_list_buckets", arguments: { project: "other-project" } });

    expect(urlOf(fetchImpl)).toBe(
      "https://eu.api.ovh.com/1.0/cloud/project/other-project/region/UK/storage",
    );
  });
});

describe("ovh_update_bucket", () => {
  it("maps `versioning` onto OVH's nested status object", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ name: "b" }));
    const client = await connect(fetchImpl);

    await client.callTool({
      name: "ovh_update_bucket",
      arguments: { bucket: "dev-rgis-ar", versioning: "enabled" },
    });

    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ versioning: { status: "enabled" } });
  });

  it("refuses an empty update rather than sending a meaningless PUT", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = await connect(fetchImpl);

    const result = await client.callTool({
      name: "ovh_update_bucket",
      arguments: { bucket: "b" },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("shape helpers", () => {
  it("keeps ownerId in a bucket summary — it decides whether a policy can bite", () => {
    expect(summarizeBucket({ name: "b", ownerId: 7 })).toMatchObject({ name: "b", ownerId: 7 });
  });

  it("stripObjects leaves everything else alone", () => {
    expect(stripObjects({ name: "b", objects: [1, 2], tags: { a: "b" } })).toEqual({
      name: "b",
      tags: { a: "b" },
    });
  });
});
