import { describe, expect, it } from "vitest";

import {
  ENDPOINTS,
  inferAuthMethod,
  loadConfig,
  oauth2TokenUrl,
  resolveBaseUrl,
  isConfigured,
  setupInstructions,
} from "#/config";

const oauth2Env = { OVH_CLIENT_ID: "cid", OVH_CLIENT_SECRET: "csecret" };
const signatureEnv = {
  OVH_APPLICATION_KEY: "ak",
  OVH_APPLICATION_SECRET: "as",
  OVH_CONSUMER_KEY: "ck",
};

describe("inferAuthMethod", () => {
  it("prefers OAuth2 when a client id + secret are present", () => {
    expect(inferAuthMethod({ ...oauth2Env, ...signatureEnv })).toBe("oauth2");
  });

  it("falls back to the application-key signature", () => {
    expect(inferAuthMethod(signatureEnv)).toBe("signature");
  });

  it("falls back to a static access token", () => {
    expect(inferAuthMethod({ OVH_ACCESS_TOKEN: "tok" })).toBe("accessToken");
  });

  it("honours an explicit override", () => {
    expect(inferAuthMethod({ ...oauth2Env, OVH_AUTH_METHOD: "signature" })).toBe("signature");
  });

  it("returns undefined with no credentials at all", () => {
    expect(inferAuthMethod({})).toBeUndefined();
  });

  it("ignores whitespace-only values", () => {
    expect(inferAuthMethod({ OVH_CLIENT_ID: "  ", OVH_CLIENT_SECRET: "  " })).toBeUndefined();
  });
});

describe("loadConfig", () => {
  it("defaults to the ovh-eu endpoint", () => {
    const config = loadConfig(oauth2Env);
    expect(config.endpoint).toBe("ovh-eu");
    expect(config.baseUrl).toBe("https://eu.api.ovh.com/1.0");
  });

  it("resolves each endpoint alias to its own API host", () => {
    expect(loadConfig({ ...oauth2Env, OVH_ENDPOINT: "ovh-ca" }).baseUrl).toBe(
      "https://ca.api.ovh.com/1.0",
    );
    expect(loadConfig({ ...oauth2Env, OVH_ENDPOINT: "ovh-us" }).baseUrl).toBe(
      "https://api.us.ovhcloud.com/1.0",
    );
  });

  it("rejects an unknown endpoint by name", () => {
    expect(() => loadConfig({ ...oauth2Env, OVH_ENDPOINT: "ovh-uk" })).toThrow(
      /Unknown OVH_ENDPOINT/,
    );
  });

  it("upper-cases the region — OVH's storage regions are upper-case", () => {
    expect(loadConfig({ ...oauth2Env, OVH_REGION: "uk" }).region).toBe("UK");
  });

  it("is read-only unless OVH_ALLOW_WRITES is explicitly on", () => {
    expect(loadConfig(oauth2Env).allowWrites).toBe(false);
    expect(loadConfig({ ...oauth2Env, OVH_ALLOW_WRITES: "0" }).allowWrites).toBe(false);
    expect(loadConfig({ ...oauth2Env, OVH_ALLOW_WRITES: "" }).allowWrites).toBe(false);
    expect(loadConfig({ ...oauth2Env, OVH_ALLOW_WRITES: "1" }).allowWrites).toBe(true);
    expect(loadConfig({ ...oauth2Env, OVH_ALLOW_WRITES: "true" }).allowWrites).toBe(true);
  });

  it("does not throw with no credentials, so the server can still start", () => {
    // It used to throw. A server that exits at startup surfaces in the client
    // as a bare "MCP error -32000: Connection closed" with stderr swallowed, so
    // the message explaining what to configure never reaches anyone. Missing
    // configuration is now a state, reported through ovh_auth_status.
    const cfg = loadConfig({});
    expect(cfg.authMethod).toBeUndefined();
    expect(isConfigured(cfg)).toBe(false);
    const steps = setupInstructions(cfg).join(" ");
    expect(steps).toContain("OVH_CLIENT_ID");
    expect(steps).toContain("OVH_APPLICATION_KEY");
    expect(steps).toContain("restart");
  });

  it("reports configured once a full credential set is present", () => {
    const cfg = loadConfig({ OVH_CLIENT_ID: "id", OVH_CLIENT_SECRET: "sec" });
    expect(isConfigured(cfg)).toBe(true);
    expect(setupInstructions(cfg)).toEqual([]);
  });

  it("requires the full triplet for the signature method", () => {
    expect(() => loadConfig({ OVH_APPLICATION_KEY: "ak", OVH_APPLICATION_SECRET: "as" })).toThrow(
      /OVH_CONSUMER_KEY/,
    );
  });

  it("requires both halves of the OAuth2 pair", () => {
    expect(() => loadConfig({ OVH_AUTH_METHOD: "oauth2", OVH_CLIENT_ID: "cid" })).toThrow(
      /OVH_CLIENT_SECRET/,
    );
  });

  it("lets OVH_API_URL override the endpoint's host", () => {
    expect(loadConfig({ ...oauth2Env, OVH_API_URL: "https://proxy.internal/1.0/" }).baseUrl).toBe(
      "https://proxy.internal/1.0",
    );
  });
});

describe("endpoints", () => {
  it("strips a trailing slash", () => {
    expect(resolveBaseUrl("ovh-eu", "https://eu.api.ovh.com/1.0//")).toBe(
      "https://eu.api.ovh.com/1.0",
    );
  });

  it("has an OAuth2 login host for the ovh-* brands only", () => {
    expect(oauth2TokenUrl("ovh-eu")).toBe("https://www.ovh.com/auth/oauth2/token");
    expect(oauth2TokenUrl("kimsufi-eu")).toBeUndefined();
  });

  it("gives every brand its own API host", () => {
    const hosts = Object.values(ENDPOINTS).map((e) => e.api);
    expect(new Set(hosts).size).toBe(hosts.length);
  });
});
