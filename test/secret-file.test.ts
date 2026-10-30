import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { staticAuthProvider } from "#/client/auth";
import type { Config } from "#/config";
import { createServer } from "#/server";
import { checkSecretFile, writeSecretFile } from "#/tools/secret-file";

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

const connect = async (
  fetchImpl: ReturnType<typeof vi.fn>,
  overrides: Partial<Config> = {},
): Promise<Client> => {
  const { server } = createServer({
    config: { ...config, ...overrides },
    fetch: fetchImpl as unknown as typeof fetch,
    auth: staticAuthProvider(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

const textOf = (result: unknown): string =>
  (result as { content: { text: string }[] }).content[0]!.text;

const payloadOf = (result: unknown): Record<string, unknown> => JSON.parse(textOf(result));

const modeOf = async (file: string): Promise<number> => (await stat(file)).mode & 0o777;

// Distinctive, so "not in the result" is a plain substring check.
const SECRET = "SK-very-secret-0123456789";
const PASSWORD = "PW-very-secret-0123456789";

let dir: string;

beforeEach(async () => {
  // realpath: macOS's tmpdir sits behind the /var -> /private/var symlink.
  dir = await realpath(await mkdtemp(join(tmpdir(), "mcp-ovh-secret-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("checkSecretFile", () => {
  it("accepts a new file in an existing directory", async () => {
    await expect(checkSecretFile(join(dir, "creds.json"), undefined)).resolves.toBe(
      join(dir, "creds.json"),
    );
  });

  it("refuses a relative path", async () => {
    await expect(checkSecretFile("creds.json", undefined)).rejects.toThrow(/absolute path/);
    await expect(checkSecretFile("./x/../creds.json", undefined)).rejects.toThrow(/absolute/);
  });

  it("refuses a missing parent directory rather than creating it", async () => {
    await expect(checkSecretFile(join(dir, "nope", "creds.json"), undefined)).rejects.toThrow(
      /does not exist/,
    );
  });

  it("refuses an existing file", async () => {
    await writeFile(join(dir, "creds.json"), "keep me");
    await expect(checkSecretFile(join(dir, "creds.json"), undefined)).rejects.toThrow(
      /already exists/,
    );
    expect(await readFile(join(dir, "creds.json"), "utf8")).toBe("keep me");
  });

  it("refuses an existing symlink, even a dangling one", async () => {
    await symlink(join(dir, "elsewhere.json"), join(dir, "creds.json"));
    await expect(checkSecretFile(join(dir, "creds.json"), undefined)).rejects.toThrow(
      /already exists/,
    );
  });

  it("confines the file to OVH_SECRET_DIR when set", async () => {
    const allowed = join(dir, "allowed");
    await mkdir(join(allowed, "sub"), { recursive: true });

    await expect(checkSecretFile(join(allowed, "a.json"), allowed)).resolves.toBe(
      join(allowed, "a.json"),
    );
    await expect(checkSecretFile(join(allowed, "sub", "a.json"), allowed)).resolves.toBe(
      join(allowed, "sub", "a.json"),
    );
    await expect(checkSecretFile(join(dir, "a.json"), allowed)).rejects.toThrow(
      /inside OVH_SECRET_DIR/,
    );
    // A sibling sharing the prefix is not inside.
    await mkdir(`${allowed}-evil`);
    await expect(checkSecretFile(join(`${allowed}-evil`, "a.json"), allowed)).rejects.toThrow(
      /inside OVH_SECRET_DIR/,
    );
    // `..` is resolved before the check.
    await expect(checkSecretFile(join(allowed, "..", "a.json"), allowed)).rejects.toThrow(
      /inside OVH_SECRET_DIR/,
    );
  });

  it("refuses a symlinked parent that leads out of OVH_SECRET_DIR", async () => {
    const allowed = join(dir, "allowed");
    const outside = join(dir, "outside");
    await mkdir(allowed);
    await mkdir(outside);
    await symlink(outside, join(allowed, "link"));

    await expect(checkSecretFile(join(allowed, "link", "a.json"), allowed)).rejects.toThrow(
      /inside OVH_SECRET_DIR/,
    );
  });

  it("refuses a relative or missing OVH_SECRET_DIR", async () => {
    await expect(checkSecretFile(join(dir, "a.json"), "secrets")).rejects.toThrow(
      /OVH_SECRET_DIR must be an absolute path/,
    );
    await expect(checkSecretFile(join(dir, "a.json"), join(dir, "missing"))).rejects.toThrow(
      /OVH_SECRET_DIR does not exist/,
    );
  });
});

describe("writeSecretFile", () => {
  it("writes pretty JSON readable by the owner only", async () => {
    const file = join(dir, "creds.json");
    await writeSecretFile(file, { access: "AK", secret: SECRET }, "unused");

    expect(await readFile(file, "utf8")).toBe(
      `${JSON.stringify({ access: "AK", secret: SECRET }, null, 2)}\n`,
    );
    expect(await modeOf(file)).toBe(0o600);
  });

  it("never overwrites, and says what to do about the credential", async () => {
    // Planted between the check and the write.
    const file = join(dir, "creds.json");
    await writeFile(file, "keep me");

    const err = await writeSecretFile(file, { secret: SECRET }, "Key AK WAS minted.").catch(
      (e: unknown) => e as Error,
    );

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Key AK WAS minted/);
    expect((err as Error).message).not.toContain(SECRET);
    expect(await readFile(file, "utf8")).toBe("keep me");
  });
});

describe("ovh_create_s3_credentials with secretFile", () => {
  const credentials = { access: "AK123", secret: SECRET, userId: "4242", tenantId: "t" };

  it("is unchanged without secretFile", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(credentials));
    const client = await connect(fetchImpl);

    const result = await client.callTool({
      name: "ovh_create_s3_credentials",
      arguments: { userId: 4242 },
    });

    expect(textOf(result)).toBe(JSON.stringify(credentials));
  });

  it("writes the secret to the file and leaves it out of the result", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(credentials));
    const client = await connect(fetchImpl);
    const file = join(dir, "creds.json");

    const result = await client.callTool({
      name: "ovh_create_s3_credentials",
      arguments: { userId: 4242, secretFile: file },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain(SECRET);
    expect(payloadOf(result)).toMatchObject({ access: "AK123", userId: "4242", secretFile: file });
    expect(payloadOf(result).note).toMatch(/NOT in this result/);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      access: "AK123",
      secret: SECRET,
      userId: 4242,
    });
    expect(await modeOf(file)).toBe(0o600);
  });

  it("refuses an existing file without minting anything", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(credentials));
    const client = await connect(fetchImpl);
    const file = join(dir, "creds.json");
    await writeFile(file, "keep me");

    const result = await client.callTool({
      name: "ovh_create_s3_credentials",
      arguments: { userId: 4242, secretFile: file },
    });

    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toMatch(/already exists/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("keep me");
  });

  it("refuses a relative path without minting anything", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(credentials));
    const client = await connect(fetchImpl);

    const result = await client.callTool({
      name: "ovh_create_s3_credentials",
      arguments: { userId: 4242, secretFile: "creds.json" },
    });

    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toMatch(/absolute path/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a path outside OVH_SECRET_DIR without minting anything", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(credentials));
    const allowed = join(dir, "allowed");
    await mkdir(allowed);
    await mkdir(join(dir, "outside"));
    await symlink(join(dir, "outside"), join(allowed, "link"));
    const client = await connect(fetchImpl, { secretDir: allowed });

    for (const file of [join(dir, "creds.json"), join(allowed, "link", "creds.json")]) {
      const result = await client.callTool({
        name: "ovh_create_s3_credentials",
        arguments: { userId: 4242, secretFile: file },
      });
      expect(result.isError, file).toBe(true);
      expect(payloadOf(result).error, file).toMatch(/inside OVH_SECRET_DIR/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names the minted key, never the secret, when the write fails after the call", async () => {
    const file = join(dir, "creds.json");
    // The file appears between the check and the write.
    const fetchImpl = vi.fn(async () => {
      await writeFile(file, "raced");
      return jsonResponse(credentials);
    });
    const client = await connect(fetchImpl);

    const result = await client.callTool({
      name: "ovh_create_s3_credentials",
      arguments: { userId: 4242, secretFile: file },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain(SECRET);
    expect(payloadOf(result).error).toMatch(/S3 access key AK123 of user 4242 WAS minted/);
    expect(payloadOf(result).error).toMatch(/ovh_delete_s3_credentials/);
    expect(await readFile(file, "utf8")).toBe("raced");
  });
});

describe("ovh_reveal_s3_secret with secretFile", () => {
  it("is unchanged without secretFile", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ secret: SECRET }));
    const client = await connect(fetchImpl);

    const result = await client.callTool({
      name: "ovh_reveal_s3_secret",
      arguments: { userId: 4242, access: "AK123" },
    });

    expect(textOf(result)).toBe(JSON.stringify({ secret: SECRET }));
  });

  it("writes the secret to the file and leaves it out of the result", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ secret: SECRET }));
    const client = await connect(fetchImpl);
    const file = join(dir, "creds.json");

    const result = await client.callTool({
      name: "ovh_reveal_s3_secret",
      arguments: { userId: 4242, access: "AK123", secretFile: file },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain(SECRET);
    expect(payloadOf(result)).toMatchObject({ userId: 4242, access: "AK123", secretFile: file });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      access: "AK123",
      secret: SECRET,
      userId: 4242,
    });
    expect(await modeOf(file)).toBe(0o600);
  });

  it("refuses an existing file without calling OVH", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ secret: SECRET }));
    const client = await connect(fetchImpl);
    const file = join(dir, "creds.json");
    await writeFile(file, "keep me");

    const result = await client.callTool({
      name: "ovh_reveal_s3_secret",
      arguments: { userId: 4242, access: "AK123", secretFile: file },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("ovh_create_project_user with secretFile", () => {
  const user = {
    id: 9001,
    username: "user-9001",
    password: PASSWORD,
    status: "creating",
    roles: [{ name: "objectstore_operator" }],
  };

  it("is unchanged without secretFile", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(user));
    const client = await connect(fetchImpl);

    const result = await client.callTool({
      name: "ovh_create_project_user",
      arguments: { description: "uploader", role: "objectstore_operator" },
    });

    expect(textOf(result)).toBe(JSON.stringify(user));
  });

  it("writes the password to the file and leaves it out of the result", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(user));
    const client = await connect(fetchImpl);
    const file = join(dir, "user.json");

    const result = await client.callTool({
      name: "ovh_create_project_user",
      arguments: { description: "uploader", role: "objectstore_operator", secretFile: file },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain(PASSWORD);
    expect(payloadOf(result)).toMatchObject({
      id: 9001,
      username: "user-9001",
      status: "creating",
      secretFile: file,
    });
    expect(payloadOf(result)).not.toHaveProperty("password");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      username: "user-9001",
      password: PASSWORD,
      userId: 9001,
    });
    expect(await modeOf(file)).toBe(0o600);
  });

  it("refuses a missing directory without creating the user", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(user));
    const client = await connect(fetchImpl);

    const result = await client.callTool({
      name: "ovh_create_project_user",
      arguments: { secretFile: join(dir, "missing", "user.json") },
    });

    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toMatch(/does not exist/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names the created user, never the password, when the write fails", async () => {
    const file = join(dir, "user.json");
    const fetchImpl = vi.fn(async () => {
      await writeFile(file, "raced");
      return jsonResponse(user);
    });
    const client = await connect(fetchImpl);

    const result = await client.callTool({
      name: "ovh_create_project_user",
      arguments: { secretFile: file },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain(PASSWORD);
    expect(payloadOf(result).error).toMatch(/Project user 9001 \(user-9001\) WAS created/);
  });
});

const provisionFetch = (onCredentials?: () => Promise<void>) =>
  vi
    .fn<() => Promise<Response>>()
    .mockResolvedValueOnce(jsonResponse({ name: "dev-rgis-ar", ownerId: 1, region: "UK" }))
    .mockResolvedValueOnce(
      jsonResponse({ id: 9001, username: "user-9001", password: PASSWORD, status: "creating" }),
    )
    .mockResolvedValueOnce(jsonResponse({ id: 9001, username: "user-9001", status: "ok" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockImplementationOnce(async () => {
      await onCredentials?.();
      return jsonResponse({ access: "AK123", secret: SECRET });
    });

describe("ovh_provision_s3_user with secretFile", () => {
  const args = { bucket: "dev-rgis-ar", preset: "write-only", prefix: "uploads/", confirm: true };

  it("is unchanged without secretFile", async () => {
    const client = await connect(provisionFetch());

    const result = await client.callTool({ name: "ovh_provision_s3_user", arguments: args });

    const payload = payloadOf(result);
    expect(Object.keys(payload)).toEqual(["bucket", "user", "policy", "credentials", "warning"]);
    expect(payload.credentials).toEqual({
      access: "AK123",
      secret: SECRET,
      endpoint: "https://s3.uk.io.cloud.ovh.net",
      region: "uk",
    });
    expect(payload.warning).toMatch(/shown once/);
    // The user-creation password never surfaced, with or without secretFile.
    expect(textOf(result)).not.toContain(PASSWORD);
  });

  it("writes the key to the file and leaves the secret out of the result", async () => {
    const client = await connect(provisionFetch());
    const file = join(dir, "creds.json");

    const result = await client.callTool({
      name: "ovh_provision_s3_user",
      arguments: { ...args, secretFile: file },
    });

    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain(SECRET);
    expect(textOf(result)).not.toContain(PASSWORD);
    const payload = payloadOf(result);
    expect(payload.credentials).toEqual({
      access: "AK123",
      endpoint: "https://s3.uk.io.cloud.ovh.net",
      region: "uk",
    });
    expect(payload).toMatchObject({ secretFile: file, user: { id: 9001, created: true } });
    expect(payload.warning).not.toMatch(/shown once/);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      access: "AK123",
      secret: SECRET,
      userId: 9001,
      username: "user-9001",
      bucket: "dev-rgis-ar",
      region: "uk",
      endpoint: "https://s3.uk.io.cloud.ovh.net",
    });
    expect(await modeOf(file)).toBe(0o600);
  });

  it("refuses an existing file before touching OVH at all", async () => {
    const fetchImpl = provisionFetch();
    const client = await connect(fetchImpl);
    const file = join(dir, "creds.json");
    await writeFile(file, "keep me");

    const result = await client.callTool({
      name: "ovh_provision_s3_user",
      arguments: { ...args, secretFile: file },
    });

    expect(result.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names the minted key and the created user when the write fails", async () => {
    const file = join(dir, "creds.json");
    const client = await connect(provisionFetch(() => writeFile(file, "raced")));

    const result = await client.callTool({
      name: "ovh_provision_s3_user",
      arguments: { ...args, secretFile: file },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toContain(SECRET);
    expect(textOf(result)).not.toContain(PASSWORD);
    const error = String(payloadOf(result).error);
    expect(error).toMatch(/S3 access key AK123 of user 9001 WAS minted/);
    expect(error).toMatch(/created by this call/);
    expect(error).toMatch(/ovh_delete_project_user/);
  });
});

describe("ovh_auth_status", () => {
  it("reports OVH_SECRET_DIR", async () => {
    const client = await connect(vi.fn(), { secretDir: "/srv/secrets" });

    const result = await client.callTool({ name: "ovh_auth_status", arguments: {} });

    expect(payloadOf(result).secretDir).toBe("/srv/secrets");
  });
});
