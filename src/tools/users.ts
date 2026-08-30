import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { encodeSegment, type OvhClient } from "#/client/ovh";
import { summarizeEach, summarizeUser } from "#/client/shape";
import { compact, confirmArg, projectArg, userIdArg, wrap } from "#/tools/util";

const OPENSTACK_ROLES = [
  "administrator",
  "authentication",
  "backup_operator",
  "compute_operator",
  "image_operator",
  "infrastructure_supervisor",
  "key-manager_operator",
  "key-manager_read",
  "load-balancer_operator",
  "network_operator",
  "network_security_operator",
  "objectstore_operator",
  "share_operator",
  "volume_operator",
] as const;

const userPath = (
  client: OvhClient,
  project: string | undefined,
  userId: number,
  suffix = "",
): string => client.projectPath(project, `/user/${encodeSegment(String(userId))}${suffix}`);

type Rec = Record<string, unknown>;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type WaitForUserOptions = {
  intervalMs?: number;
  maxAttempts?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Block until a project user is actually usable.
 *
 * OVH creates a project user ASYNCHRONOUSLY: the POST answers immediately with
 * an id and `status: "creating"`, and for the next few seconds the user is a
 * half-thing — `GET .../user/{id}` returns it, but every write against that id
 * (attaching its policy, minting S3 credentials) fails with a flatly misleading
 * `404 user {id} not found`. Poll until the status flips to `ok`.
 */
export const waitForUserReady = async (
  client: OvhClient,
  project: string | undefined,
  userId: number,
  opts: WaitForUserOptions = {},
): Promise<Rec> => {
  const intervalMs = opts.intervalMs ?? 1000;
  const maxAttempts = opts.maxAttempts ?? 30;
  const sleep = opts.sleep ?? defaultSleep;

  let status: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const user = await client.get<Rec>(userPath(client, project, userId));
    status = user.status;
    if (status === "ok") return user;
    if (status === "deleted" || status === "deleting") {
      throw new Error(`Project user ${userId} is being deleted (status '${String(status)}').`);
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Project user ${userId} was still '${String(status)}' after ` +
      `${maxAttempts} checks over ~${Math.round((maxAttempts * intervalMs) / 1000)}s. ` +
      `OVH provisions users asynchronously; check the OVH console before retrying.`,
  );
};

export const registerUserTools = (
  server: McpServer,
  client: OvhClient,
  allowWrites: boolean,
): void => {
  server.registerTool(
    "ovh_list_project_users",
    {
      title: "OVHcloud: List Project Users",
      description:
        "List the project's OpenStack users. These — not your OVH account — are what S3 " +
        "credentials and storage policies attach to. The numeric `id` is what every " +
        "user-scoped tool takes.",
      inputSchema: { project: projectArg },
      annotations: { readOnlyHint: true },
    },
    async ({ project }) =>
      wrap(async () =>
        summarizeEach(await client.get(client.projectPath(project, "/user")), summarizeUser),
      ),
  );

  server.registerTool(
    "ovh_get_project_user",
    {
      title: "OVHcloud: Get Project User",
      description: "Get one project user with its OpenStack roles and status.",
      inputSchema: { project: projectArg, userId: userIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ project, userId }) => wrap(() => client.get(userPath(client, project, userId))),
  );

  server.registerTool(
    "ovh_list_s3_credentials",
    {
      title: "OVHcloud: List S3 Credentials",
      description:
        "List a user's S3 credentials. Only the access keys are returned — OVH never lists " +
        "secrets. Use `ovh_reveal_s3_secret` for the secret of one access key.",
      inputSchema: { project: projectArg, userId: userIdArg },
      annotations: { readOnlyHint: true },
    },
    async ({ project, userId }) =>
      wrap(() => client.get(userPath(client, project, userId, "/s3Credentials"))),
  );

  if (!allowWrites) return;

  server.registerTool(
    "ovh_create_project_user",
    {
      title: "OVHcloud: Create Project User",
      description:
        "Create a project user. This is the FIRST step to a restricted S3 key: because an S3 " +
        "policy cannot restrict a bucket's owner, a write-only or read-only key must belong to " +
        "a user that did NOT create the bucket. " +
        "`objectstore_operator` is the role for object storage. Creating a user also mints an " +
        "OpenStack password, which is returned once and never again. " +
        'The user is created ASYNCHRONOUSLY and comes back with `status: "creating"` — for the ' +
        "next few seconds any write against its id (policy, S3 credentials) fails with a " +
        "misleading `404 user not found`. Poll `ovh_get_project_user` until the status is `ok`, " +
        "or use `ovh_provision_s3_user`, which waits for you.",
      inputSchema: {
        project: projectArg,
        description: z
          .string()
          .optional()
          .describe("Human label, e.g. `ar-app-uploader`. Strongly recommended."),
        role: z
          .enum(OPENSTACK_ROLES)
          .optional()
          .describe("Single OpenStack role. For object storage use `objectstore_operator`."),
        roles: z
          .array(z.enum(OPENSTACK_ROLES))
          .optional()
          .describe("Several OpenStack roles at once. Mutually exclusive with `role`."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ project, description, role, roles }) =>
      wrap(() =>
        client.post(client.projectPath(project, "/user"), compact({ description, role, roles })),
      ),
  );

  server.registerTool(
    "ovh_create_s3_credentials",
    {
      title: "OVHcloud: Create S3 Credentials",
      description:
        "Mint a new S3 access key + secret for a project user. " +
        "THE SECRET IS RETURNED HERE AND CAN BE RE-READ ONLY VIA `ovh_reveal_s3_secret` — " +
        "capture it now. The key inherits whatever the user's storage policy allows, so set " +
        "the policy BEFORE handing the key out. " +
        "A just-created user returns `404 user not found` here until its status reaches `ok`.",
      inputSchema: { project: projectArg, userId: userIdArg },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ project, userId }) =>
      wrap(() => client.post(userPath(client, project, userId, "/s3Credentials"))),
  );

  server.registerTool(
    "ovh_reveal_s3_secret",
    {
      title: "OVHcloud: Reveal S3 Secret",
      description:
        "Reveal the secret key behind an existing S3 access key. Returns a live credential in " +
        "plain text — do not paste the result anywhere it will be persisted.",
      inputSchema: {
        project: projectArg,
        userId: userIdArg,
        access: z.string().min(1).describe("The S3 access key."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ project, userId, access }) =>
      wrap(() =>
        client.post(
          userPath(client, project, userId, `/s3Credentials/${encodeSegment(access)}/secret`),
        ),
      ),
  );

  server.registerTool(
    "ovh_delete_s3_credentials",
    {
      title: "OVHcloud: Delete S3 Credentials",
      description:
        "Revoke one S3 access key. Immediate — anything still using it starts failing with 403 " +
        "at once. The user and its other keys are untouched.",
      inputSchema: {
        project: projectArg,
        userId: userIdArg,
        access: z.string().min(1).describe("The S3 access key to revoke."),
        confirm: confirmArg,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ project, userId, access }) =>
      wrap(() =>
        client.del(userPath(client, project, userId, `/s3Credentials/${encodeSegment(access)}`)),
      ),
  );

  server.registerTool(
    "ovh_delete_project_user",
    {
      title: "OVHcloud: Delete Project User",
      description:
        "Delete a project user, along with every S3 credential and storage policy attached to " +
        "it. Irreversible. If this user OWNS any bucket, deal with the bucket first — an " +
        "ownerless bucket is painful to recover.",
      inputSchema: { project: projectArg, userId: userIdArg, confirm: confirmArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ project, userId }) => wrap(() => client.del(userPath(client, project, userId))),
  );
};
