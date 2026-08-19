import { describe, expect, it } from "vitest";

import { buildPolicy, encodePolicy, POLICY_PRESETS } from "../src/storage/policy.js";

const actions = (preset: (typeof POLICY_PRESETS)[number], prefix?: string): string[] =>
  buildPolicy({ bucket: "dev-rgis-ar", preset, prefix }).Statement.flatMap((s) => s.Action);

describe("write-only preset", () => {
  it("grants no read of any kind", () => {
    const granted = actions("write-only");
    expect(granted).not.toContain("s3:GetObject");
    expect(granted).not.toContain("s3:ListBucket");
    expect(granted).not.toContain("s3:GetBucketLocation");
  });

  it("grants no delete", () => {
    expect(actions("write-only")).not.toContain("s3:DeleteObject");
  });

  it("grants PutObject plus the multipart pair", () => {
    // Without abort/list, an SDK's auto-multipart upload orphans parts that the
    // key holder then cannot clean up — and which keep billing.
    expect(actions("write-only")).toEqual([
      "s3:PutObject",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts",
    ]);
  });

  it("scopes the object ARN to the prefix with a trailing wildcard", () => {
    const doc = buildPolicy({ bucket: "dev-rgis-ar", preset: "write-only", prefix: "uploads/" });
    expect(doc.Statement[0]?.Resource).toEqual(["arn:aws:s3:::dev-rgis-ar/uploads/*"]);
  });

  it("covers the whole bucket when no prefix is given", () => {
    const doc = buildPolicy({ bucket: "dev-rgis-ar", preset: "write-only" });
    expect(doc.Statement[0]?.Resource).toEqual(["arn:aws:s3:::dev-rgis-ar/*"]);
  });

  it("tolerates a leading slash on the prefix", () => {
    const doc = buildPolicy({ bucket: "b", preset: "write-only", prefix: "/uploads/" });
    expect(doc.Statement[0]?.Resource).toEqual(["arn:aws:s3:::b/uploads/*"]);
  });
});

describe("read-only preset", () => {
  it("puts ListBucket on the BUCKET arn, not the object arn", () => {
    // A ListBucket grant on `arn:aws:s3:::b/*` silently does nothing — this is
    // the single most common reason a read key 403s on `aws s3 ls`.
    const list = buildPolicy({ bucket: "b", preset: "read-only" }).Statement.find(
      (s) => s.Sid === "ListBucket",
    );
    expect(list?.Resource).toEqual(["arn:aws:s3:::b"]);
  });

  it("grants no write", () => {
    const granted = actions("read-only");
    expect(granted).not.toContain("s3:PutObject");
    expect(granted).not.toContain("s3:DeleteObject");
  });
});

describe("read-write preset", () => {
  it("grants read, write and delete", () => {
    const granted = actions("read-write");
    for (const action of ["s3:GetObject", "s3:ListBucket", "s3:PutObject", "s3:DeleteObject"]) {
      expect(granted, action).toContain(action);
    }
  });
});

describe("encodePolicy", () => {
  it("sends the document as a JSON STRING — OVH ignores a nested object", () => {
    const encoded = encodePolicy(buildPolicy({ bucket: "b", preset: "read-only" }));
    expect(typeof encoded.policy).toBe("string");
    expect(JSON.parse(encoded.policy).Version).toBe("2012-10-17");
  });

  it("passes an already-serialized document through untouched", () => {
    expect(encodePolicy('{"Version":"2012-10-17"}').policy).toBe('{"Version":"2012-10-17"}');
  });
});
