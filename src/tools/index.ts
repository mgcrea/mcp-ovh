import type { McpServer } from "@modelcontextprotocol/server";

import type { OvhClient } from "#/client/ovh";
import { isConfigured, type Config } from "#/config";
import { registerBucketTools } from "#/tools/buckets";
import { registerObjectTools } from "#/tools/objects";
import { registerPolicyTools } from "#/tools/policies";
import { registerProjectTools } from "#/tools/projects";
import { registerRequestTool } from "#/tools/request";
import { registerStatusTool } from "#/tools/status";
import { registerUserTools } from "#/tools/users";

export type ToolContext = {
  config: Config;
  /** Register the mutating tools too. Off by default — see OVH_ALLOW_WRITES. */
  allowWrites: boolean;
};

/**
 * Register the OVHcloud tools.
 *
 * ovh_auth_status comes first and unconditionally, so an unconfigured server is
 * still a useful one — it can say what to set — rather than a connection that
 * closes. Everything else needs real credentials.
 *
 * Read tools are then always registered; the write tools only when `allowWrites`
 * is set, so with the flag off they are not merely refused — they are
 * invisible, and cannot be called at all.
 */
export const registerTools = (server: McpServer, client: OvhClient, ctx: ToolContext): void => {
  const { allowWrites } = ctx;
  registerStatusTool(server, ctx);
  if (!isConfigured(ctx.config)) return;

  registerProjectTools(server, client);
  registerBucketTools(server, client, allowWrites);
  registerObjectTools(server, client, allowWrites);
  registerUserTools(server, client, allowWrites);
  registerPolicyTools(server, client, allowWrites);
  registerRequestTool(server, client, allowWrites);
};
