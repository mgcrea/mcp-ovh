import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { fetchServerTime } from "#/client/auth";
import type { OvhClient } from "#/client/ovh";
import { summarizeRegion } from "#/client/shape";
import { projectArg, regionArg, wrap } from "#/tools/util";

type Rec = Record<string, unknown>;

export const registerProjectTools = (server: McpServer, client: OvhClient): void => {
  server.registerTool(
    "ovh_whoami",
    {
      title: "OVHcloud: Whoami",
      description:
        "Show which OVHcloud identity the server is authenticated as, which auth method is " +
        "live (oauth2 / signature / accessToken), the API endpoint, the default project and " +
        "region, whether writes are enabled, and the clock delta against OVH's own time. " +
        "Call this FIRST when another tool returns 401 or 403 — a 401 on the signature method " +
        "is usually clock drift, and a 403 is nearly always a consumer key whose access rules " +
        "do not cover the path.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const [me, serverTime] = await Promise.all([
          client.get<Rec>("/me"),
          fetchServerTime(client.baseUrl).catch(() => undefined),
        ]);
        return {
          authMethod: client.authMethod,
          endpoint: client.baseUrl,
          defaultProject: client.defaultProject ?? null,
          defaultRegion: client.defaultRegion ?? null,
          account: {
            nichandle: me.nichandle,
            email: me.email,
            name: [me.firstname, me.name].filter(Boolean).join(" "),
            organisation: me.organisation,
            country: me.country,
            state: me.state,
          },
          clock:
            serverTime === undefined
              ? { reachable: false }
              : {
                  reachable: true,
                  ovhTime: serverTime,
                  localTime: Math.floor(Date.now() / 1000),
                  driftSeconds: serverTime - Math.floor(Date.now() / 1000),
                },
        };
      }),
  );

  server.registerTool(
    "ovh_list_projects",
    {
      title: "OVHcloud: List Projects",
      description:
        "List the public cloud project ids (`serviceName`) this account can see. These 32-char " +
        "hex ids are what every other project-scoped tool takes — never the display name.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      wrap(async () => {
        const ids = await client.get<string[]>("/cloud/project");
        // A bare id list is unusable without names, and there are rarely more
        // than a handful of projects, so resolve them.
        const projects = await Promise.all(
          (Array.isArray(ids) ? ids : []).map(async (id) => {
            try {
              const project = await client.get<Rec>(`/cloud/project/${encodeURIComponent(id)}`);
              return {
                serviceName: id,
                projectName: project.projectName,
                description: project.description,
                status: project.status,
                access: project.access,
              };
            } catch {
              return { serviceName: id };
            }
          }),
        );
        return projects;
      }),
  );

  server.registerTool(
    "ovh_get_project",
    {
      title: "OVHcloud: Get Project",
      description: "Get one public cloud project: name, status, access level, plan and quotas.",
      inputSchema: { project: projectArg },
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => wrap(() => client.get(client.projectPath(project))),
  );

  server.registerTool(
    "ovh_list_regions",
    {
      title: "OVHcloud: List Regions",
      description:
        "List the regions enabled on a project. Storage regions are upper-case (`GRA`, `SBG`, " +
        "`DE`, `UK`, `WAW`) and a bucket lives in exactly one of them.",
      inputSchema: { project: projectArg },
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => wrap(() => client.get<string[]>(client.projectPath(project, "/region"))),
  );

  server.registerTool(
    "ovh_get_region",
    {
      title: "OVHcloud: Get Region",
      description:
        "Get one region: its type, status, availability zones, and the per-service component " +
        "status (which tells you whether object storage is actually up there).",
      inputSchema: { project: projectArg, region: regionArg },
      annotations: { readOnlyHint: true },
    },
    async ({ project, region }) =>
      wrap(async () =>
        summarizeRegion(
          await client.get<Rec>(
            client.projectPath(project, `/region/${encodeURIComponent(client.region(region))}`),
          ),
        ),
      ),
  );
};
