import { describe, expect, it } from "vitest";

import { clockDelta, signRequest } from "#/client/signature";

// Vectors computed independently of the implementation:
//   printf '%s' 'AS+CK+METHOD+URL+BODY+TS' | openssl sha1
// They pin the exact join order and separator, so a refactor that reshuffles the
// parts fails here rather than at runtime with an opaque "Invalid signature".
describe("signRequest", () => {
  it("matches a known vector for a bodyless GET", () => {
    expect(
      signRequest({
        applicationSecret: "AS_SECRET",
        consumerKey: "CK_CONSUMER",
        method: "GET",
        url: "https://eu.api.ovh.com/1.0/me",
        body: "",
        timestamp: 1700000000,
      }),
    ).toBe("$1$52caefaa1a601c277697c15d0527e15f546779e6");
  });

  it("matches a known vector for a POST with a JSON body", () => {
    expect(
      signRequest({
        applicationSecret: "AS_SECRET",
        consumerKey: "CK_CONSUMER",
        method: "POST",
        url: "https://eu.api.ovh.com/1.0/cloud/project/abc/user",
        body: JSON.stringify({ description: "test" }),
        timestamp: 1700000000,
      }),
    ).toBe("$1$3ec0703e511f5c558eac6319bc818dd907407174");
  });

  it("upper-cases the method, so a lowercase verb still signs correctly", () => {
    const base = {
      applicationSecret: "AS_SECRET",
      consumerKey: "CK_CONSUMER",
      url: "https://eu.api.ovh.com/1.0/me",
      body: "",
      timestamp: 1700000000,
    };
    expect(signRequest({ ...base, method: "get" })).toBe(signRequest({ ...base, method: "GET" }));
  });

  it("signs the query string too — the URL is the FULL url", () => {
    const base = {
      applicationSecret: "AS_SECRET",
      consumerKey: "CK_CONSUMER",
      method: "GET",
      body: "",
      timestamp: 1700000000,
    };
    expect(signRequest({ ...base, url: "https://x/1.0/s?noObjects=true" })).not.toBe(
      signRequest({ ...base, url: "https://x/1.0/s" }),
    );
  });
});

describe("clockDelta", () => {
  it("is zero for a machine in sync", () => {
    expect(clockDelta(1700000000, 1700000000_000)).toBe(0);
  });

  it("is positive when the local clock is behind OVH's", () => {
    expect(clockDelta(1700000060, 1700000000_000)).toBe(60);
  });

  it("is negative when the local clock runs ahead", () => {
    expect(clockDelta(1700000000, 1700000090_000)).toBe(-90);
  });

  it("floors sub-second local time rather than rounding it up", () => {
    expect(clockDelta(1700000000, 1700000000_999)).toBe(0);
  });
});
