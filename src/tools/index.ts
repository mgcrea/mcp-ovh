import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { OvhClient } from "../client/ovh.js";
import { isConfigured, type Config } from "../config.js";
import { registerBucketTools } from "./buckets.js";
import { registerObjectTools } from "./objects.js";
import { registerPolicyTools } from "./policies.js";
import { registerProjectTools } from "./projects.js";
import { registerRequestTool } from "./request.js";
import { registerStatusTool } from "./status.js";
import { registerUserTools } from "./users.js";

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
