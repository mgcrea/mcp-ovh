import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { encodeSegment, type OvhClient } from "#/client/ovh";
import { summarizeEach, summarizeObject } from "#/client/shape";
import {
  bucketArg,
  compact,
  confirmArg,
  limitArg,
  objectKeyArg,
  projectArg,
  regionArg,
  wrap,
} from "#/tools/util";

const STORAGE_CLASSES = [
  "STANDARD",
  "STANDARD_IA",
  "HIGH_PERF",
  "GLACIER_IR",
  "DEEP_ARCHIVE",
] as const;

const storageClassArg = z
  .enum(STORAGE_CLASSES)
  .optional()
  .describe("Storage class. `GLACIER_IR` and `DEEP_ARCHIVE` objects must be restored before use.");

/** Object keys contain `/`, so each is one fully-encoded path segment. */
const objectPath = (
  client: OvhClient,
  project: string | undefined,
  region: string | undefined,
  bucket: string,
  key: string,
  suffix = "",
): string => client.storagePath(project, region, bucket, `/object/${encodeSegment(key)}${suffix}`);

export const registerObjectTools = (
  server: McpServer,
  client: OvhClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "ovh_list_objects",
    {
      description:
        "List the objects in a bucket. Use `prefix` to scope to a folder (`uploads/`) and " +
        '`delimiter: "/"` to get folder-style common prefixes instead of a flat recursive ' +
        "listing. Paginate with `keyMarker` from the last key of the previous page.",
      inputSchema: {
        project: projectArg,
        region: regionArg,
        bucket: bucketArg,
        prefix: z.string().optional().describe("Only keys starting with this prefix."),
        delimiter: z
          .string()
          .optional()
          .describe(
            'Group keys sharing a prefix up to this character. Pass "/" for folder-style ' +
              "listing; entries then come back with `isCommonPrefix: true`.",
          ),
        limit: limitArg,
        keyMarker: z.string().optional().describe("Resume listing after this key."),
        versionIdMarker: z
          .string()
          .optional()
          .describe("Resume listing after this version id. Only with `withVersions`."),
        withVersions: z
          .boolean()
          .optional()
          .describe(
            "Include every version and delete marker, not just current objects. Only " +
              "meaningful on a versioned bucket.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, region, bucket, limit, ...filters }) =>
      wrap(async () =>
        summarizeEach(
          await client.get(client.storagePath(project, region, bucket, "/object"), {
            ...compact(filters),
            limit,
          }),
          summarizeObject,
        ),
      ),
  );

  server.registerTool(
    "ovh_get_object",
    {
      description:
        "Get one object's METADATA — size, etag, storage class, lock and replication status. " +
        "This does not download the content; use `ovh_presign_object` with method GET for that.",
      inputSchema: {
        project: projectArg,
        region: regionArg,
        bucket: bucketArg,
        key: objectKeyArg,
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, region, bucket, key }) =>
      wrap(() => client.get(objectPath(client, project, region, bucket, key))),
  );

  server.registerTool(
    "ovh_list_object_versions",
    {
      description:
        "List every stored version of one object, newest first, including delete markers. " +
        "Only a versioned bucket has more than one.",
      inputSchema: {
        project: projectArg,
        region: regionArg,
        bucket: bucketArg,
        key: objectKeyArg,
        limit: limitArg,
        versionIdMarker: z.string().optional().describe("Resume after this version id."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, region, bucket, key, limit, versionIdMarker }) =>
      wrap(async () =>
        summarizeEach(
          await client.get(objectPath(client, project, region, bucket, key, "/version"), {
            limit,
            versionIdMarker,
          }),
          summarizeObject,
        ),
      ),
  );

  server.registerTool(
    "ovh_presign_object",
    {
      description:
        "Mint a time-limited presigned S3 URL for one object — the only way to actually move " +
        "bytes through this server, which never proxies content itself. " +
        "GET downloads, PUT uploads, DELETE removes. " +
        (allowWrites
          ? "All three methods are available."
          : "Writes are disabled, so only GET is offered.") +
        " The URL carries the credentials of the CALLING identity, so anyone holding it has " +
        "that access until it expires — treat it as a secret.",
      inputSchema: {
        project: projectArg,
        region: regionArg,
        bucket: bucketArg,
        key: objectKeyArg,
        method: z
          .enum(allowWrites ? (["GET", "PUT", "DELETE"] as const) : (["GET"] as const))
          .default("GET")
          .describe("HTTP method the URL is signed for."),
        expire: z
          .number()
          .int()
          .min(1)
          .max(604800)
          .default(3600)
          .describe("Lifetime in seconds (max 7 days). Defaults to 1 hour."),
        versionId: z.string().optional().describe("Target a specific version, for GET or DELETE."),
        storageClass: storageClassArg,
      },
      annotations: { readOnlyHint: !allowWrites, destructiveHint: false },
    },
    async ({ project, region, bucket, key, method, expire, versionId, storageClass }) =>
      wrap(() =>
        client.post(client.storagePath(project, region, bucket, "/presign"), {
          object: key,
          method,
          expire,
          ...compact({ versionId, storageClass }),
        }),
      ),
  );

  if (!allowWrites) return;

  server.registerTool(
    "ovh_copy_object",
    {
      description:
        "Server-side copy of an object, without the bytes leaving OVH. Pass `targetBucket` to " +
        "copy across buckets in the same region, or keep the same bucket and change " +
        "`storageClass` to move an object between storage tiers in place.",
      inputSchema: {
        project: projectArg,
        region: regionArg,
        bucket: bucketArg,
        key: objectKeyArg,
        targetBucket: z
          .string()
          .optional()
          .describe("Destination bucket. Defaults to the source bucket."),
        targetKey: z.string().optional().describe("Destination key. Defaults to the source key."),
        storageClass: storageClassArg,
        versionId: z.string().optional().describe("Copy this specific version of the source."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ project, region, bucket, key, targetBucket, targetKey, storageClass, versionId }) =>
      wrap(() =>
        client.post(
          objectPath(
            client,
            project,
            region,
            bucket,
            key,
            versionId ? `/version/${encodeSegment(versionId)}/copy` : "/copy",
          ),
          compact({ targetBucket, targetKey, storageClass }),
        ),
      ),
  );

  server.registerTool(
    "ovh_delete_object",
    {
      description:
        "Delete an object. On a VERSIONED bucket this only writes a delete marker — the data " +
        "stays (and keeps billing) until the versions are deleted too. On an unversioned " +
        "bucket it is immediate and irreversible.",
      inputSchema: {
        project: projectArg,
        region: regionArg,
        bucket: bucketArg,
        key: objectKeyArg,
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ project, region, bucket, key }) =>
      wrap(() => client.del(objectPath(client, project, region, bucket, key))),
  );

  server.registerTool(
    "ovh_delete_object_version",
    {
      description:
        "PERMANENTLY delete one specific version of an object. Unlike `ovh_delete_object` this " +
        "destroys the data outright, with no delete marker and no recovery — it is how you " +
        "actually reclaim space on a versioned bucket.",
      inputSchema: {
        project: projectArg,
        region: regionArg,
        bucket: bucketArg,
        key: objectKeyArg,
        versionId: z.string().min(1).describe("Version id, from `ovh_list_object_versions`."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ project, region, bucket, key, versionId }) =>
      wrap(() =>
        client.del(
          objectPath(client, project, region, bucket, key, `/version/${encodeSegment(versionId)}`),
        ),
      ),
  );

  server.registerTool(
    "ovh_bulk_delete_objects",
    {
      description:
        "Delete many objects in one call. Returns `deleted` and `errors` separately — a " +
        "partial failure is reported, not thrown, so always read both. Pass `versionId` on an " +
        "entry to purge that exact version rather than write a delete marker. " +
        "This is how you empty a bucket before deleting it.",
      inputSchema: {
        project: projectArg,
        region: regionArg,
        bucket: bucketArg,
        objects: z
          .array(
            z.object({
              key: z.string().min(1),
              versionId: z.string().optional(),
            }),
          )
          .min(1)
          .max(1000)
          .describe("Objects to delete, up to 1000 per call."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ project, region, bucket, objects }) =>
      wrap(() =>
        client.post(client.storagePath(project, region, bucket, "/bulkDeleteObjects"), {
          objects: objects.map((o) => compact(o)),
        }),
      ),
  );
};
