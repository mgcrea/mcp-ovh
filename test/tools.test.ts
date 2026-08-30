import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { staticAuthProvider } from "#/client/auth";
import { OvhClient } from "#/client/ovh";
import type { Config } from "#/config";
import { createServer } from "#/server";
import { assertSafePath } from "#/tools/request";
import { waitForUserReady } from "#/tools/users";

const baseConfig: Config = {
  endpoint: "ovh-eu",
  baseUrl: "https://eu.api.ovh.com/1.0",
  authMethod: "accessToken",
  accessToken: "tok",
  cloudProject: "abcdef0123456789abcdef0123456789",
  region: "UK",
  allowWrites: false,
  maxRetries: 3,
  refreshSkewSeconds: 60,
};

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const connect = async (
  config: Config,
  fetchImpl: typeof fetch = vi.fn(async () => jsonResponse([])) as unknown as typeof fetch,
): Promise<Client> => {
  const { server } = createServer({ config, fetch: fetchImpl, auth: staticAuthProvider() });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const toolNames = async (client: Client): Promise<string[]> =>
  (await client.listTools()).tools.map((t) => t.name).toSorted();

const enumOf = async (
  client: Client,
  tool: string,
  prop: string,
): Promise<string[] | undefined> => {
  const found = (await client.listTools()).tools.find((t) => t.name === tool);
  if (!found) throw new Error(`tool ${tool} is not registered`);
  const properties = found.inputSchema.properties as Record<string, { enum?: string[] }>;
  return properties[prop]?.enum;
};

const PROJECT_BASE = "https://eu.api.ovh.com/1.0/cloud/project/abcdef0123456789abcdef0123456789";

const payloadOf = (result: unknown): Record<string, unknown> =>
  JSON.parse((result as { content: { text: string }[] }).content[0]!.text);

describe("tool registration", () => {
  let readOnly: string[];
  let withWrites: string[];

  beforeAll(async () => {
    readOnly = await toolNames(await connect(baseConfig));
    withWrites = await toolNames(await connect({ ...baseConfig, allowWrites: true }));
  });

  it("registers the read tools in both modes", () => {
    for (const name of [
      "ovh_whoami",
      "ovh_list_projects",
      "ovh_get_project",
      "ovh_list_regions",
      "ovh_list_buckets",
      "ovh_get_bucket",
      "ovh_get_bucket_lifecycle",
      "ovh_list_objects",
      "ovh_get_object",
      "ovh_list_object_versions",
      "ovh_presign_object",
      "ovh_list_project_users",
      "ovh_list_s3_credentials",
      "ovh_get_storage_policy",
      "ovh_preview_policy",
      "ovh_request",
    ]) {
      expect(readOnly, name).toContain(name);
      expect(withWrites, name).toContain(name);
    }
  });

  it("hides every write tool when writes are disabled", () => {
    // Not merely refused — absent, so an agent cannot call them at all.
    const writeTools = withWrites.filter((name) => !readOnly.includes(name));
    expect(writeTools.length).toBeGreaterThan(15);
    for (const name of [
      "ovh_create_bucket",
      "ovh_update_bucket",
      "ovh_delete_bucket",
      "ovh_delete_object",
      "ovh_bulk_delete_objects",
      "ovh_create_project_user",
      "ovh_create_s3_credentials",
      "ovh_reveal_s3_secret",
      "ovh_set_storage_policy",
      "ovh_grant_bucket_access",
      "ovh_provision_s3_user",
    ]) {
      expect(readOnly, name).not.toContain(name);
      expect(withWrites, name).toContain(name);
    }
  });

  it("marks read tools readOnly and destructive ones destructive", async () => {
    const client = await connect({ ...baseConfig, allowWrites: true });
    const byName = new Map((await client.listTools()).tools.map((t) => [t.name, t]));

    expect(byName.get("ovh_list_buckets")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("ovh_delete_bucket")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("ovh_delete_object_version")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("ovh_set_storage_policy")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("ovh_create_bucket")?.annotations?.destructiveHint).toBe(false);
  });
});

describe("ovh_request", () => {
  it("only offers GET when writes are disabled", async () => {
    const client = await connect(baseConfig);
    expect(await enumOf(client, "ovh_request", "method")).toEqual(["GET"]);
    const tool = (await client.listTools()).tools.find((t) => t.name === "ovh_request");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });

  it("offers the write methods when writes are enabled", async () => {
    const client = await connect({ ...baseConfig, allowWrites: true });
    expect(await enumOf(client, "ovh_request", "method")).toEqual(["GET", "POST", "PUT", "DELETE"]);
  });

  it("resolves a path against the API root", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = await connect(baseConfig, fetchImpl as unknown as typeof fetch);

    await client.callTool({ name: "ovh_request", arguments: { path: "me" } });

    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://eu.api.ovh.com/1.0/me",
    );
  });
});

describe("assertSafePath", () => {
  it("rejects an absolute URL, so the credentials can't be sent to another host", () => {
    expect(() => assertSafePath("https://evil.example.com/steal")).toThrow(/absolute URL/);
  });

  it("rejects traversal", () => {
    expect(() => assertSafePath("cloud/../../..")).toThrow(/\.\./);
  });

  it("allows normal API paths", () => {
    expect(() => assertSafePath("/me")).not.toThrow();
    expect(() => assertSafePath("cloud/project")).not.toThrow();
  });
});

describe("ovh_presign_object", () => {
  it("offers only GET when writes are disabled", async () => {
    const client = await connect(baseConfig);
    expect(await enumOf(client, "ovh_presign_object", "method")).toEqual(["GET"]);
  });

  it("offers PUT and DELETE when writes are enabled", async () => {
    const client = await connect({ ...baseConfig, allowWrites: true });
    expect(await enumOf(client, "ovh_presign_object", "method")).toEqual(["GET", "PUT", "DELETE"]);
  });
});

describe("destructive tools", () => {
  it("refuse to run without an explicit confirm", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "ovh_delete_bucket",
      arguments: { bucket: "dev-rgis-ar" },
    });

    expect(result.isError).toBe(true);
    // Crucially: it never reached OVH.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("run when confirmed", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "ovh_delete_bucket",
      arguments: { bucket: "dev-rgis-ar", confirm: true },
    });

    expect(result.isError).toBeFalsy();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://eu.api.ovh.com/1.0/cloud/project/abcdef0123456789abcdef0123456789/region/UK/storage/dev-rgis-ar",
    );
    expect(init.method).toBe("DELETE");
  });
});

describe("ovh_set_storage_policy", () => {
  it("rejects being given both a preset and a raw policy", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "ovh_set_storage_policy",
      arguments: { userId: 1, preset: "write-only", bucket: "b", policy: {}, confirm: true },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the preset document as a JSON string", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    await client.callTool({
      name: "ovh_set_storage_policy",
      arguments: {
        userId: 4242,
        preset: "write-only",
        bucket: "dev-rgis-ar",
        prefix: "uploads/",
        confirm: true,
      },
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/user/4242/policy");
    const body = JSON.parse(init.body as string) as { policy: string };
    expect(typeof body.policy).toBe("string");
    expect(JSON.parse(body.policy).Statement[0].Resource).toEqual([
      "arn:aws:s3:::dev-rgis-ar/uploads/*",
    ]);
  });
});

describe("ovh_provision_s3_user", () => {
  it("refuses to restrict a user that OWNS the bucket", async () => {
    // A policy is a no-op against the owner: OVH falls back to ACLs and grants
    // the owner FULL_CONTROL regardless.
    const fetchImpl = vi.fn(async () => jsonResponse({ name: "dev-rgis-ar", ownerId: 4242 }));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "ovh_provision_s3_user",
      arguments: {
        bucket: "dev-rgis-ar",
        preset: "write-only",
        userId: 4242,
        confirm: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toMatch(/OWNS bucket/);
    // Only the bucket lookup happened — no user was touched.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("creates the user, applies the policy, THEN mints the credentials", async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ name: "dev-rgis-ar", ownerId: 1, region: "UK" }))
      .mockResolvedValueOnce(jsonResponse({ id: 9001, username: "user-9001", status: "creating" }))
      .mockResolvedValueOnce(jsonResponse({ id: 9001, username: "user-9001", status: "ok" }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ access: "AK123", secret: "SK456" }));
    const client = await connect(
      { ...baseConfig, allowWrites: true },
      fetchImpl as unknown as typeof fetch,
    );

    const result = await client.callTool({
      name: "ovh_provision_s3_user",
      arguments: {
        bucket: "dev-rgis-ar",
        preset: "write-only",
        prefix: "uploads/",
        description: "ar-app-uploader",
        confirm: true,
      },
    });

    expect(result.isError).toBeFalsy();
    const urls = fetchImpl.mock.calls.map((c) => (c as unknown as [string])[0]);
    // Order matters: a key that exists before its policy is a key that briefly
    // had whatever the default allows.
    expect(urls[1]).toContain("/user");
    // The readiness poll sits between the create and the policy: OVH 404s the
    // policy write while the user is still "creating".
    expect(urls[2]).toBe(`${PROJECT_BASE}/user/9001`);
    expect(urls[3]).toContain("/user/9001/policy");
    expect(urls[4]).toContain("/user/9001/s3Credentials");

    const payload = payloadOf(result) as Record<string, Record<string, unknown>>;
    expect(payload.credentials).toMatchObject({
      access: "AK123",
      secret: "SK456",
      endpoint: "https://s3.uk.io.cloud.ovh.net",
    });
    expect(payload.user).toMatchObject({ id: 9001, created: true });
  });
});

const bareClient = (fetchImpl: ReturnType<typeof vi.fn>): OvhClient =>
  new OvhClient({
    baseUrl: "https://eu.api.ovh.com/1.0",
    auth: staticAuthProvider(),
    defaultProject: "proj",
    fetch: fetchImpl as unknown as typeof fetch,
  });

describe("waitForUserReady", () => {
  it("polls until OVH flips the status to ok", async () => {
    // OVH answers the create immediately, but the user is a half-thing for a few
    // seconds: writes against its id 404 with a misleading "user not found".
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ id: 1, status: "creating" }))
      .mockResolvedValueOnce(jsonResponse({ id: 1, status: "creating" }))
      .mockResolvedValueOnce(jsonResponse({ id: 1, status: "ok", username: "user-x" }));
    const sleep = vi.fn(async () => {});

    const user = await waitForUserReady(bareClient(fetchImpl), "proj", 1, { sleep });

    expect(user).toMatchObject({ status: "ok", username: "user-x" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns at once for a user that is already ok", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1, status: "ok" }));
    const sleep = vi.fn(async () => {});

    await waitForUserReady(bareClient(fetchImpl), "proj", 1, { sleep });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up rather than polling forever", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1, status: "creating" }));

    await expect(
      waitForUserReady(bareClient(fetchImpl), "proj", 1, { maxAttempts: 3, sleep: async () => {} }),
    ).rejects.toThrow(/still 'creating' after 3 checks/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fails fast on a user that is being deleted", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 1, status: "deleting" }));

    await expect(
      waitForUserReady(bareClient(fetchImpl), "proj", 1, { sleep: async () => {} }),
    ).rejects.toThrow(/being deleted/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
