/**
 * S3 policy documents for OVHcloud Object Storage.
 *
 * Two things about OVH's IAM that make this file necessary, and both are traps:
 *
 * 1. **OVH has no bucket policies** — only *user* policies. One raw JSON
 *    document per project user, written via `POST /cloud/project/{p}/user/{u}/policy`.
 *    There is nowhere to attach a policy to a bucket.
 * 2. **A policy cannot restrict the bucket owner.** OVH falls back to ACLs, and
 *    the owner holds FULL_CONTROL: "if the user is the bucket owner and even if
 *    there is no explicit allow in the policy file, the user will be authorized".
 *    A restricted key must therefore belong to a NEW project user that did not
 *    create the bucket. Check the bucket's `ownerId` first.
 * 3. **The same fallback applies per OBJECT.** Whoever uploads an object OWNS it
 *    and gets FULL_CONTROL on it through the object ACL, so merely *omitting*
 *    `s3:GetObject` does NOT stop a write-only key from reading back its own
 *    uploads. Verified against the live API: an explicit `Deny` is required, and
 *    it does win over the ACL. This is why `write-only` carries a Deny statement
 *    rather than a bare allow-list.
 *
 * OVH's own role shortcut (`POST .../storage/{name}/policy/{userId}`) offers only
 * admin | deny | readOnly | readWrite. There is no write-only role, which is why
 * the raw-JSON path exists.
 */

export const POLICY_PRESETS = ["write-only", "read-only", "read-write"] as const;
export type PolicyPreset = (typeof POLICY_PRESETS)[number];

export type PolicyStatement = {
  Sid?: string;
  Effect: "Allow" | "Deny";
  Action: string[];
  Resource: string[];
};

export type PolicyDocument = {
  Version: "2012-10-17";
  Statement: PolicyStatement[];
};

export type BuildPolicyOptions = {
  bucket: string;
  preset: PolicyPreset;
  /**
   * Restrict object actions to keys under this prefix, e.g. `uploads/`. Omitted
   * means the whole bucket.
   */
  prefix?: string | undefined;
};

const bucketArn = (bucket: string): string => `arn:aws:s3:::${bucket}`;

/**
 * `arn:aws:s3:::bucket/prefix*`. The trailing `*` is deliberate and is what
 * scopes the grant; a prefix without it would match one exact key.
 */
const objectArn = (bucket: string, prefix?: string): string =>
  `arn:aws:s3:::${bucket}/${(prefix ?? "").replace(/^\/+/, "")}*`;

// Uploading through any S3 SDK auto-switches to multipart above ~8-16MB. Without
// AbortMultipartUpload and ListMultipartUploadParts, a failed or aborted upload
// leaves orphaned parts that the key's owner then cannot clean up — and which
// keep billing.
const MULTIPART_ACTIONS = ["s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"];

/**
 * OVH validates policy actions against a fixed enum and rejects the whole
 * document with a 400 if one is unknown. Notable absentees that exist in AWS:
 * `s3:GetObjectVersion` and `s3:DeleteObjectVersion`.
 */
const DENIED_READ_ACTIONS = ["s3:GetObject", "s3:GetObjectAcl"];

/** Build the raw policy document for a preset. */
export const buildPolicy = (opts: BuildPolicyOptions): PolicyDocument => {
  const { bucket, preset, prefix } = opts;
  const objects = objectArn(bucket, prefix);
  const statements: PolicyStatement[] = [];

  if (preset === "read-only" || preset === "read-write") {
    statements.push({
      Sid: "ListBucket",
      Effect: "Allow",
      // ListBucket is a BUCKET-level action: its resource is the bucket ARN with
      // no key suffix. Putting it on the object ARN is the single most common
      // reason a "read-only" key gets 403 on `aws s3 ls`.
      Action: ["s3:ListBucket", "s3:GetBucketLocation"],
      Resource: [bucketArn(bucket)],
    });
    statements.push({
      Sid: "ReadObjects",
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: [objects],
    });
  }

  if (preset === "write-only" || preset === "read-write") {
    statements.push({
      Sid: "WriteObjects",
      Effect: "Allow",
      Action: [
        "s3:PutObject",
        ...MULTIPART_ACTIONS,
        ...(preset === "read-write" ? ["s3:DeleteObject"] : []),
      ],
      Resource: [objects],
    });
  }

  if (preset === "write-only") {
    // Not redundant with the omitted allow. The uploader owns what it uploads
    // and the object ACL grants the owner FULL_CONTROL, so without this an
    // "upload-only" key can still GET back everything it ever wrote. The Deny is
    // bucket-wide on purpose: reading outside the prefix is no more acceptable.
    statements.push({
      Sid: "DenyReadBack",
      Effect: "Deny",
      Action: DENIED_READ_ACTIONS,
      Resource: [`${bucketArn(bucket)}/*`],
    });
  }

  return { Version: "2012-10-17", Statement: statements };
};

/**
 * OVH takes the policy as a JSON *string* in `{"policy": "..."}`, not as a nested
 * object. Sending the object directly is accepted and then silently ignored.
 */
export const encodePolicy = (document: PolicyDocument | unknown): { policy: string } => ({
  policy: typeof document === "string" ? document : JSON.stringify(document),
});

/** One-line human summary of what a preset actually grants. */
export const describePreset = (preset: PolicyPreset): string => {
  switch (preset) {
    case "write-only":
      return "PutObject + multipart abort/list inside the prefix, plus an explicit Deny on GetObject/GetObjectAcl across the whole bucket — without that Deny the key could read back its own uploads, because the uploader owns them. No ListBucket, no DeleteObject. Note PutObject alone still permits blind OVERWRITE of an existing key inside the prefix.";
    case "read-only":
      return "ListBucket + GetBucketLocation on the bucket, GetObject on the objects. No writes.";
    case "read-write":
      return "Everything read-only grants, plus PutObject, DeleteObject and multipart abort/list.";
  }
};
