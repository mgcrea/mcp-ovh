import { describe, expect, it } from "vitest";

import { buildPolicy, encodePolicy, POLICY_PRESETS } from "#/storage/policy";

/** Actions the policy ALLOWS — Deny statements are counted separately. */
const actions = (preset: (typeof POLICY_PRESETS)[number], prefix?: string): string[] =>
  buildPolicy({ bucket: "dev-rgis-ar", preset, prefix })
    .Statement.filter((s) => s.Effect === "Allow")
    .flatMap((s) => s.Action);

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

  it("explicitly DENIES read-back across the whole bucket", () => {
    // Verified against the live API: omitting s3:GetObject is not enough. The
    // uploader owns what it uploads and the object ACL grants the owner
    // FULL_CONTROL, so an allow-list-only policy still lets the key GET back
    // everything it wrote. An explicit Deny does win over that ACL.
    const doc = buildPolicy({ bucket: "dev-rgis-ar", preset: "write-only", prefix: "uploads/" });
    const deny = doc.Statement.find((s) => s.Effect === "Deny");
    expect(deny?.Action).toEqual(["s3:GetObject", "s3:GetObjectAcl"]);
    // Bucket-wide, not prefix-scoped: reading outside the prefix is no better.
    expect(deny?.Resource).toEqual(["arn:aws:s3:::dev-rgis-ar/*"]);
  });

  it("uses only actions OVH's policy validator accepts", () => {
    // OVH rejects the whole document with a 400 on an unknown action, and its
    // enum omits AWS staples like s3:GetObjectVersion.
    const OVH_ACTIONS = new Set([
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:GetBucketLocation",
      "s3:GetObject",
      "s3:GetObjectAcl",
      "s3:ListBucket",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ]);
    for (const preset of POLICY_PRESETS) {
      for (const statement of buildPolicy({ bucket: "b", preset }).Statement) {
        for (const action of statement.Action) {
          expect(OVH_ACTIONS.has(action), `${preset}: ${action}`).toBe(true);
        }
      }
    }
  });
});

describe("read-only and read-write presets", () => {
  it("carry no Deny statement — only write-only needs one", () => {
    for (const preset of ["read-only", "read-write"] as const) {
      const denies = buildPolicy({ bucket: "b", preset }).Statement.filter(
        (s) => s.Effect === "Deny",
      );
      expect(denies, preset).toHaveLength(0);
    }
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
