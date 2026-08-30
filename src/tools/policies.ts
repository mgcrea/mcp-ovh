import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { encodeSegment, type OvhClient } from "#/client/ovh";
import { parsePolicyRaw, summarizeBucket } from "#/client/shape";
import {
  buildPolicy,
  describePreset,
  encodePolicy,
  POLICY_PRESETS,
  type PolicyPreset,
} from "#/storage/policy";
import { waitForUserReady } from "#/tools/users";
import {
  bucketArg,
  compact,
  confirmArg,
  projectArg,
  regionArg,
  userIdArg,
  wrap,
} from "#/tools/util";

type Rec = Record<string, unknown>;

/** The trap that governs this whole module, repeated wherever it can bite. */
const OWNER_WARNING =
  "TRAP: an S3 policy is a NO-OP against the bucket's OWNER. OVH falls back to ACLs and the " +
  "owner keeps FULL_CONTROL whatever the policy says. A restricted key must therefore belong " +
  "to a project user that did NOT create the bucket — check the bucket's `ownerId` first.";

const presetArg = z
  .enum(POLICY_PRESETS)
  .describe(
    "Policy preset. `write-only` = PutObject + multipart abort/list only (no read, no list, " +
      "no delete). `read-only` = ListBucket + GetObject. `read-write` = both plus DeleteObject. " +
      "OVH's own role shortcut has no write-only equivalent, which is why these exist.",
  );

const prefixArg = z
  .string()
  .optional()
  .describe(
    "Scope object actions to keys under this prefix, e.g. `uploads/`. Omit for the whole " +
      "bucket. Note that within the allowed prefix, `s3:PutObject` still permits blind " +
      "OVERWRITE of existing keys.",
  );

export const registerPolicyTools = (
  server: McpServer,
  client: OvhClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "ovh_get_storage_policy",
    {
      title: "OVHcloud: Get Storage Policy",
      description:
        "Get a project user's storage policy — the raw S3 policy document that governs what " +
        "its S3 keys may do. OVH has no bucket policies: this ONE document per user is the " +
        "whole access-control surface. " +
        OWNER_WARNING,
      inputSchema: { project: projectArg, userId: userIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ project, userId }) =>
      wrap(async () =>
        parsePolicyRaw(
          await client.get(
            client.projectPath(project, `/user/${encodeSegment(String(userId))}/policy`),
          ),
        ),
      ),
  );

  server.registerTool(
    "ovh_preview_policy",
    {
      title: "OVHcloud: Preview Policy",
      description:
        "Build the policy document a preset would produce, WITHOUT applying it. Use this to " +
        "check the ARNs and actions before calling `ovh_set_storage_policy` or " +
        "`ovh_provision_s3_user`.",
      inputSchema: { bucket: bucketArg, preset: presetArg, prefix: prefixArg },
      annotations: { readOnlyHint: true },
    },
    async ({ bucket, preset, prefix }) =>
      wrap(async () => ({
        preset,
        grants: describePreset(preset),
        policy: buildPolicy({ bucket, preset, prefix }),
      })),
  );

  if (!allowWrites) return;

  server.registerTool(
    "ovh_set_storage_policy",
    {
      title: "OVHcloud: Set Storage Policy",
      description:
        "REPLACE a project user's storage policy. There is one document per user, so this " +
        "overwrites everything that user could previously do across ALL buckets — read the " +
        "current one with `ovh_get_storage_policy` first if the user has other access. " +
        "Pass either `preset` + `bucket` (+ optional `prefix`), or a raw `policy` document. " +
        OWNER_WARNING,
      inputSchema: {
        project: projectArg,
        userId: userIdArg,
        preset: presetArg.optional(),
        bucket: bucketArg
          .optional()
          .describe("Bucket the preset applies to. Required with `preset`."),
        prefix: prefixArg,
        policy: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe(
            "Raw S3 policy document, as an object or a JSON string. Mutually exclusive with " +
              "`preset`. Use it for anything the presets don't cover.",
          ),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ project, userId, preset, bucket, prefix, policy }) =>
      wrap(async () => {
        if (preset && policy) {
          throw new Error("Pass either `preset` or `policy`, not both.");
        }
        if (!preset && !policy) {
          throw new Error("Pass one of `preset` (with `bucket`) or a raw `policy` document.");
        }
        if (preset && !bucket) {
          throw new Error("`bucket` is required when using `preset`.");
        }
        const document = preset
          ? buildPolicy({ bucket: bucket as string, preset, prefix })
          : (policy as unknown);
        await client.post(
          client.projectPath(project, `/user/${encodeSegment(String(userId))}/policy`),
          encodePolicy(document),
        );
        return { userId, applied: document, ...(preset ? { grants: describePreset(preset) } : {}) };
      }),
  );

  server.registerTool(
    "ovh_grant_bucket_access",
    {
      title: "OVHcloud: Grant Bucket Access",
      description:
        "Grant a project user one of OVH's built-in roles on a bucket: `admin`, `readOnly`, " +
        "`readWrite` or `deny`. Simpler than a raw policy, but there is NO write-only role — " +
        "for that use `ovh_set_storage_policy` with the `write-only` preset. " +
        "This writes the same underlying per-user document as `ovh_set_storage_policy`, so the " +
        "two overwrite each other. " +
        OWNER_WARNING,
      inputSchema: {
        project: projectArg,
        region: regionArg,
        bucket: bucketArg,
        userId: userIdArg,
        roleName: z
          .enum(["admin", "deny", "readOnly", "readWrite"])
          .describe("Built-in role to grant."),
        objectKey: z
          .string()
          .optional()
          .describe("Restrict the role to keys under this prefix. Omit for the whole bucket."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ project, region, bucket, userId, roleName, objectKey }) =>
      wrap(async () => {
        await client.post(
          client.storagePath(project, region, bucket, `/policy/${encodeSegment(String(userId))}`),
          compact({ roleName, objectKey }),
        );
        return { bucket, userId, roleName, objectKey: objectKey ?? null };
      }),
  );

  server.registerTool(
    "ovh_provision_s3_user",
    {
      title: "OVHcloud: Provision S3 User",
      description:
        "Composite: create a project user, apply a policy preset scoped to one bucket, and mint " +
        "S3 credentials — the whole recipe for handing out a restricted key in one call. " +
        "RETURNS A LIVE ACCESS KEY AND SECRET in plain text; the secret is shown here and " +
        "nowhere else afterwards. " +
        "It first reads the bucket and REFUSES to proceed if you point it at an existing user " +
        "that owns the bucket, because a policy cannot restrict an owner. " +
        "Typical use: a write-only key for an app that uploads but must never read back — note " +
        "that `write-only` still allows overwriting existing keys inside the prefix.",
      inputSchema: {
        project: projectArg,
        region: regionArg,
        bucket: bucketArg,
        preset: presetArg,
        prefix: prefixArg,
        description: z
          .string()
          .optional()
          .describe("Label for the new user, e.g. `ar-app-uploader`."),
        userId: userIdArg
          .optional()
          .describe(
            "Reuse an EXISTING project user instead of creating one. Its policy is replaced " +
              "wholesale. Rejected if this user owns the bucket.",
          ),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ project, region, bucket, preset, prefix, description, userId }) =>
      wrap(async () => {
        const container = summarizeBucket(
          await client.get<Rec>(client.storagePath(project, region, bucket), { noObjects: true }),
        );
        const ownerId = container.ownerId;

        if (userId !== undefined && ownerId !== undefined && Number(ownerId) === userId) {
          throw new Error(
            `User ${userId} OWNS bucket '${bucket}'. An S3 policy cannot restrict the bucket ` +
              `owner — OVH falls back to ACLs and grants the owner FULL_CONTROL regardless. ` +
              `Create a separate user instead (omit \`userId\`).`,
          );
        }

        const created =
          userId === undefined
            ? await client.post<Rec>(
                client.projectPath(project, "/user"),
                compact({ description, role: "objectstore_operator" }),
              )
            : undefined;

        const newUserId = created ? Number(created.id) : userId;
        if (typeof newUserId !== "number" || !Number.isFinite(newUserId)) {
          throw new Error(`Could not determine the new user's id from OVH's response.`);
        }

        // OVH provisions the user asynchronously. Until its status reaches `ok`,
        // writing its policy fails with a misleading `404 user not found`.
        const user = await waitForUserReady(client, project, newUserId);

        // Policy BEFORE credentials: a key that exists for even a moment with no
        // policy is a key that briefly had whatever the default allows.
        const document = buildPolicy({ bucket, preset, prefix });
        await client.post(
          client.projectPath(project, `/user/${encodeSegment(String(newUserId))}/policy`),
          encodePolicy(document),
        );

        const credentials = await client.post<Rec>(
          client.projectPath(project, `/user/${encodeSegment(String(newUserId))}/s3Credentials`),
        );

        return {
          bucket: { name: container.name, region: container.region, ownerId },
          user: {
            id: newUserId,
            username: user.username,
            description: user.description ?? description,
            status: user.status,
            created: userId === undefined,
          },
          policy: { preset: preset as PolicyPreset, grants: describePreset(preset), document },
          credentials: {
            access: credentials.access,
            secret: credentials.secret,
            endpoint: `https://s3.${String(client.region(region)).toLowerCase()}.io.cloud.ovh.net`,
            region: client.region(region).toLowerCase(),
          },
          warning:
            "The secret above is shown once. Store it now. Verify the key with the real S3 API " +
            "before handing it over — a policy that looks right can still be shadowed by bucket " +
            "ownership.",
        };
      }),
  );
};
