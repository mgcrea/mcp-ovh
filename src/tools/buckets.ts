import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { OvhClient } from "#/client/ovh";
import { stripObjects, summarizeBucket, summarizeEach } from "#/client/shape";
import {
  bucketArg,
  compact,
  compactOrUndefined,
  confirmArg,
  projectArg,
  regionArg,
  wrap,
} from "#/tools/util";

type Rec = Record<string, unknown>;

const VERSIONING = ["disabled", "enabled", "suspended"] as const;
const ENCRYPTION = ["AES256", "plaintext"] as const;

const versioningArg = z
  .enum(VERSIONING)
  .optional()
  .describe(
    "Versioning status. Can be turned on at any time, but once enabled it can only be " +
      "`suspended`, never returned to `disabled`.",
  );

const tagsArg = z
  .record(z.string(), z.string())
  .optional()
  .describe("Bucket tags, as a flat string map.");

const lifecycleArg = z
  .record(z.string(), z.unknown())
  .describe(
    'Lifecycle configuration: {"rules": [{"id": "expire-tmp", "status": "enabled", ' +
      '"filter": {"prefix": "tmp/"}, "expiration": {"days": 7}}]}. Rules support ' +
      "`expiration`, `transitions`, `noncurrentVersionExpiration`, " +
      "`noncurrentVersionTransitions` and `abortIncompleteMultipartUpload`.",
  );

export const registerBucketTools = (
  server: McpServer,
  client: OvhClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "ovh_list_buckets",
    {
      title: "OVHcloud: List Buckets",
      description:
        "List the object storage buckets in a region, with their object count, total size and " +
        "owner. Note `ownerId`: an S3 policy is a NO-OP against the bucket owner, who always " +
        "keeps FULL_CONTROL through ACLs — a restricted key must belong to a different user.",
      inputSchema: z.object({ project: projectArg, region: regionArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, region }) =>
      wrap(async () =>
        summarizeEach(await client.get(client.storagePath(project, region)), summarizeBucket),
      ),
  );

  server.registerTool(
    "ovh_get_bucket",
    {
      title: "OVHcloud: Get Bucket",
      description:
        "Get one bucket's configuration: versioning, encryption, object lock, replication, " +
        "lifecycle, tags and owner. Object listing is deliberately suppressed (the raw endpoint " +
        "embeds a deprecated array of EVERY object) — use `ovh_list_objects` for contents.",
      inputSchema: z.object({ project: projectArg, region: regionArg, bucket: bucketArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, region, bucket }) =>
      wrap(async () =>
        stripObjects(
          await client.get<Rec>(client.storagePath(project, region, bucket), {
            // Belt and braces: ask OVH not to build the array, then strip it
            // anyway in case an older API version ignores the flag.
            noObjects: true,
          }),
        ),
      ),
  );

  server.registerTool(
    "ovh_get_bucket_lifecycle",
    {
      title: "OVHcloud: Get Bucket Lifecycle",
      description:
        "Get a bucket's lifecycle rules — expiration, storage-class transitions, noncurrent " +
        "version cleanup, and incomplete-multipart abort.",
      inputSchema: z.object({ project: projectArg, region: regionArg, bucket: bucketArg }),
      annotations: { readOnlyHint: true },
    },
    async ({ project, region, bucket }) =>
      wrap(() => client.get(client.storagePath(project, region, bucket, "/lifecycle"))),
  );

  if (!allowWrites) return;

  server.registerTool(
    "ovh_create_bucket",
    {
      title: "OVHcloud: Create Bucket",
      description:
        "Create an object storage bucket. " +
        "Two settings are CREATE-TIME ONLY and cannot be added later: `objectLock` and, in " +
        "practice, the encryption algorithm. Versioning can be toggled afterwards with " +
        "`ovh_update_bucket`. " +
        "`ownerId` decides who holds FULL_CONTROL forever — leave it unset to own the bucket as " +
        "the calling identity, and never point it at a user you later intend to restrict.",
      inputSchema: z.object({
        project: projectArg,
        region: regionArg,
        name: z.string().min(1).describe("Bucket name. Must be unique within the region."),
        versioning: versioningArg,
        encryption: z
          .enum(ENCRYPTION)
          .optional()
          .describe("Server-side encryption algorithm. `AES256` or `plaintext`."),
        objectLock: z
          .enum(["enabled", "disabled"])
          .optional()
          .describe(
            "Object lock (WORM). CREATE-TIME ONLY — it can never be enabled on an existing " +
              "bucket, and enabling it forces versioning on.",
          ),
        ownerId: z
          .number()
          .int()
          .optional()
          .describe("Project user id to own the bucket. Defaults to the calling identity."),
        tags: tagsArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ project, region, name, versioning, encryption, objectLock, ownerId, tags }) =>
      wrap(async () =>
        stripObjects(
          await client.post<Rec>(
            client.storagePath(project, region),
            compact({
              name,
              ownerId,
              tags,
              versioning: versioning ? { status: versioning } : undefined,
              encryption: encryption ? { sseAlgorithm: encryption } : undefined,
              objectLock: objectLock ? { status: objectLock } : undefined,
            }),
          ),
        ),
      ),
  );

  server.registerTool(
    "ovh_update_bucket",
    {
      title: "OVHcloud: Update Bucket",
      description:
        "Update a bucket in place: versioning, tags, encryption, replication or lifecycle. " +
        "Only the fields you pass are sent. Object lock cannot be changed here — it is " +
        "create-time only.",
      inputSchema: z.object({
        project: projectArg,
        region: regionArg,
        bucket: bucketArg,
        versioning: versioningArg,
        tags: tagsArg,
        encryption: z.enum(ENCRYPTION).optional(),
        replication: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Replication configuration: {"rules": [...]}.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ project, region, bucket, versioning, tags, encryption, replication }) =>
      wrap(async () => {
        const body = compactOrUndefined({
          tags,
          replication,
          versioning: versioning ? { status: versioning } : undefined,
          encryption: encryption ? { sseAlgorithm: encryption } : undefined,
        });
        if (!body) {
          throw new Error(
            "Nothing to update — pass at least one of versioning, tags, encryption, replication.",
          );
        }
        return stripObjects(
          await client.put<Rec>(client.storagePath(project, region, bucket), body),
        );
      }),
  );

  server.registerTool(
    "ovh_set_bucket_lifecycle",
    {
      title: "OVHcloud: Set Bucket Lifecycle",
      description:
        "Replace a bucket's lifecycle configuration. This REPLACES the whole document — read " +
        "the current one with `ovh_get_bucket_lifecycle` first and send it back with your rule " +
        "added, or the existing rules are dropped.",
      inputSchema: z.object({
        project: projectArg,
        region: regionArg,
        bucket: bucketArg,
        lifecycle: lifecycleArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ project, region, bucket, lifecycle }) =>
      wrap(() => client.put(client.storagePath(project, region, bucket, "/lifecycle"), lifecycle)),
  );

  server.registerTool(
    "ovh_delete_bucket_lifecycle",
    {
      title: "OVHcloud: Delete Bucket Lifecycle",
      description:
        "Remove a bucket's lifecycle configuration entirely. Scheduled expirations and " +
        "transitions stop; nothing already deleted comes back.",
      inputSchema: z.object({
        project: projectArg,
        region: regionArg,
        bucket: bucketArg,
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ project, region, bucket }) =>
      wrap(() => client.del(client.storagePath(project, region, bucket, "/lifecycle"))),
  );

  server.registerTool(
    "ovh_delete_bucket",
    {
      title: "OVHcloud: Delete Bucket",
      description:
        "DELETE A BUCKET. Irreversible, with no trash. OVH refuses to delete a bucket that " +
        "still holds objects (or, on a versioned bucket, any version or delete marker) — empty " +
        "it first with `ovh_bulk_delete_objects`.",
      inputSchema: z.object({
        project: projectArg,
        region: regionArg,
        bucket: bucketArg,
        confirm: confirmArg,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ project, region, bucket }) =>
      wrap(() => client.del(client.storagePath(project, region, bucket))),
  );
};
