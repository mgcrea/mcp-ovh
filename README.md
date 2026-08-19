# @mgcrea/mcp-ovh-api

[![npm version](https://img.shields.io/npm/v/@mgcrea/mcp-ovh-api.svg?style=for-the-badge)](https://www.npmjs.com/package/@mgcrea/mcp-ovh-api)
[![GHCR](https://img.shields.io/badge/ghcr.io-container_image-2496ED?style=for-the-badge&logo=docker&logoColor=white)](https://github.com/mgcrea/mcp-ovh-api/pkgs/container/mcp-ovh-api)

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **OVHcloud API**,
focused on **Object Storage**: buckets, objects, project users, S3 credentials and the
storage policies that tie them together.

The server is **read-only by default**. Mutating tools are not merely refused when writes are
off — they are never registered, so an agent cannot call them at all.

## Features

- Curated tools over OVHcloud's `/1.0` API with descriptions that spell out its traps (see
  [Traps worth knowing](#traps-worth-knowing)).
- **Read-only by default.** `OVH_ALLOW_WRITES=1` adds the write tools; the destructive ones
  then additionally require an explicit `confirm: true` on every call.
- All three OVH auth methods, picked automatically from whichever env vars are present:
  **OAuth2 service account** (recommended), **application key + consumer key** (SHA1-signed,
  with automatic clock-drift correction), or a **static access token**.
- Policy presets — including **`write-only`**, which OVH's own role shortcut does not offer.
- List results are summarized, and OVH's deprecated per-bucket `objects[]` array (which
  embeds _every_ object in the bucket) is suppressed on both ends.
- `X-Ovh-QueryID` is surfaced on every error, because that is the first thing OVH support
  asks for.
- An `ovh_request` escape hatch for the rest of the API (GET-only unless writes are enabled).
- Native `fetch`, no runtime dependencies beyond the MCP SDK and Zod.

## Install

```bash
pnpm install
pnpm build
```

## Configure

Pick one auth method.

### (A) OAuth2 service account — recommended

1. Create an IAM service account at
   <https://www.ovh.com/manager/#/iam/service-account>.
2. Attach an IAM policy granting it your public cloud project (for object storage:
   `publicCloudProject:apiovh:*` on the project resource).
3. Copy the client id and secret into `.env`.

Tokens last an hour and are cached and refreshed ahead of expiry.

### (B) Application key + consumer key

Create the triplet in one shot at <https://eu.api.ovh.com/createToken/>. **The access rules
you list there are fixed forever** — a consumer key cannot be widened afterwards, so grant
what you need up front:

```
GET    /cloud/project/*
POST   /cloud/project/*
PUT    /cloud/project/*
DELETE /cloud/project/*
GET    /me
```

Requests are SHA1-signed over `secret+consumerKey+METHOD+URL+BODY+TIMESTAMP`. A clock more
than ~30s off OVH's fails _every_ call with a misleading `Invalid signature`, so the server
probes `/auth/time` once at startup and corrects for the delta.

### (C) Static access token

Set `OVH_ACCESS_TOKEN` and it is sent as `Authorization: Bearer`.

```bash
cp .env.example .env
```

| Variable                              | Required | Description                                                            |
| ------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `OVH_ENDPOINT`                        | no       | `ovh-eu` (default), `ovh-ca`, `ovh-us`, `kimsufi-*`, `soyoustart-*`.   |
| `OVH_CLIENT_ID` / `OVH_CLIENT_SECRET` | (A)      | IAM service account. Their presence selects OAuth2.                    |
| `OVH_APPLICATION_KEY` / `_SECRET`     | (B)      | Application key pair.                                                  |
| `OVH_CONSUMER_KEY`                    | (B)      | Consumer key issued alongside them.                                    |
| `OVH_ACCESS_TOKEN`                    | (C)      | Pre-minted bearer token.                                               |
| `OVH_AUTH_METHOD`                     | no       | Force `oauth2`, `signature` or `accessToken`. Otherwise inferred.      |
| `OVH_CLOUD_PROJECT`                   | no       | Default project — the 32-char hex `serviceName`, not the display name. |
| `OVH_REGION`                          | no       | Default storage region, upper-case (`GRA`, `SBG`, `DE`, `UK`).         |
| `OVH_ALLOW_WRITES`                    | no       | Set to `1` to register the write tools. Off by default.                |
| `OVH_API_URL`                         | no       | Override the API base URL entirely.                                    |
| `OVH_MAX_RETRIES`                     | no       | Retry budget for 401 / 429 / 5xx. Defaults to `3`.                     |
| `OVH_REFRESH_SKEW_SECONDS`            | no       | Refresh the OAuth2 token this long before expiry. Defaults to `60`.    |
| `OVH_DEBUG`                           | no       | Set to `1` to log debug output to stderr.                              |

## Run

```bash
pnpm start   # speaks JSON-RPC over stdio
```

### Wire into Claude Code

Add to `.mcp.json` (project) or `~/.claude.json` (global):

```json
{
  "mcpServers": {
    "ovh": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-ovh-api/dist/cli.js"],
      "env": {
        "OVH_CLIENT_ID": "...",
        "OVH_CLIENT_SECRET": "...",
        "OVH_CLOUD_PROJECT": "abcdef0123456789abcdef0123456789",
        "OVH_REGION": "UK"
      }
    }
  }
}
```

### Inspect the tools

```bash
npx @modelcontextprotocol/inspector node dist/cli.js
```

## Traps worth knowing

All are baked into the tool descriptions, but they explain the shape of this server:

1. **OVH has no bucket policies — only _user_ policies.** One raw JSON document per project
   user, and that document is the entire access-control surface. Setting a policy replaces
   everything that user could previously do, across all buckets.
2. **A policy cannot restrict the bucket's owner.** OVH falls back to ACLs and the owner
   holds `FULL_CONTROL`: _"if the user is the bucket owner and even if there is no explicit
   allow in the policy file, the user will be authorized."_ A restricted key must therefore
   belong to a **new project user** that did not create the bucket. `ovh_provision_s3_user`
   checks the bucket's `ownerId` and refuses when you point it at the owner.

3. **The same fallback applies per object.** Whoever uploads an object _owns_ it and gets
   `FULL_CONTROL` on it through the object ACL. So merely _omitting_ `s3:GetObject` does
   **not** stop an upload-only key from reading back everything it wrote — verified against
   the live API, where a bare allow-list policy happily served the key its own uploads while
   correctly denying every object someone else had uploaded. An explicit `Deny` **is**
   required, and it does beat the ACL. That is why the `write-only` preset ships a `Deny`
   statement rather than a bare allow-list.

Two smaller ones. `s3:PutObject` alone still permits blind **overwrite** of existing keys
inside the allowed prefix — a "write-only" key is not an append-only key, which is a good
reason to enable versioning on the bucket. And **policy changes take up to ~30 seconds to
propagate**: a probe run five seconds after `ovh_set_storage_policy` still shows the old
behaviour, which reads exactly like a policy that silently failed.

## Tools

Every project-scoped tool takes an optional `project`, and every storage tool an optional
`region`, overriding `OVH_CLOUD_PROJECT` / `OVH_REGION` per call. Tools marked **W** exist
only when `OVH_ALLOW_WRITES=1`; those marked ⚠️ are destructive and additionally require
`confirm: true`.

**Start with `ovh_whoami`.** It reports which auth method is live, which account you are, and
the clock delta against OVH — which is what a 401 on the signature method is nearly always
about.

| Area         | Tools                                                                                                                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meta         | `ovh_whoami`, `ovh_list_projects`, `ovh_get_project`, `ovh_list_regions`, `ovh_get_region`                                                                                                                                       |
| Buckets      | `ovh_list_buckets`, `ovh_get_bucket`, `ovh_get_bucket_lifecycle` · **W** `ovh_create_bucket`, `ovh_update_bucket`, `ovh_set_bucket_lifecycle`, ⚠️ `ovh_delete_bucket_lifecycle`, ⚠️ `ovh_delete_bucket`                          |
| Objects      | `ovh_list_objects`, `ovh_get_object`, `ovh_list_object_versions`, `ovh_presign_object` · **W** `ovh_copy_object`, ⚠️ `ovh_delete_object`, ⚠️ `ovh_delete_object_version`, ⚠️ `ovh_bulk_delete_objects`                           |
| Users & keys | `ovh_list_project_users`, `ovh_get_project_user`, `ovh_list_s3_credentials` · **W** `ovh_create_project_user`, `ovh_create_s3_credentials`, `ovh_reveal_s3_secret`, ⚠️ `ovh_delete_s3_credentials`, ⚠️ `ovh_delete_project_user` |
| Policies     | `ovh_get_storage_policy`, `ovh_preview_policy` · **W** ⚠️ `ovh_set_storage_policy`, ⚠️ `ovh_grant_bucket_access`, ⚠️ `ovh_provision_s3_user`                                                                                     |
| Escape hatch | `ovh_request` — any `/1.0` path, GET-only unless writes are enabled                                                                                                                                                              |

`ovh_presign_object` is the only way bytes move: the server never proxies object content, it
mints a time-limited presigned S3 URL instead. With writes off it signs `GET` only.

### Policy presets

`ovh_preview_policy`, `ovh_set_storage_policy` and `ovh_provision_s3_user` share three
presets, all scopable to a key prefix:

| Preset       | Grants                                                                                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write-only` | Allow `s3:PutObject`, `s3:AbortMultipartUpload`, `s3:ListMultipartUploadParts` on the prefix — **plus an explicit `Deny` on `s3:GetObject` / `s3:GetObjectAcl` bucket-wide** |
| `read-only`  | `s3:ListBucket` + `s3:GetBucketLocation` on the bucket, `s3:GetObject` on the objects                                                                                        |
| `read-write` | both, plus `s3:DeleteObject`                                                                                                                                                 |

OVH's built-in roles (`admin`, `deny`, `readOnly`, `readWrite`, via `ovh_grant_bucket_access`)
have no write-only equivalent — that is why the raw-policy path exists. The multipart pair is
included deliberately: every S3 SDK auto-switches to multipart above ~8-16MB, and without
abort/list a failed upload orphans parts the key holder cannot clean up and keeps paying for.

OVH validates policy actions against a fixed enum and rejects the **whole document** with a
400 if one is unknown — `s3:GetObjectVersion` and `s3:DeleteObjectVersion` exist in AWS but
not there. The presets use only accepted actions, and a test pins that.

### Handing out a write-only upload key

The motivating case: an app embeds an S3 key in a shipped binary, so the key must be able to
upload and nothing else, while the read/write key stays with the developer.

```
ovh_get_bucket           bucket=dev-rgis-ar          → note ownerId
ovh_preview_policy       bucket=dev-rgis-ar preset=write-only prefix=uploads/
ovh_provision_s3_user    bucket=dev-rgis-ar preset=write-only prefix=uploads/ \
                         description=ar-app-uploader confirm=true
```

That creates a _new_ project user (never the bucket owner), applies the policy, and only then
mints credentials — a key that exists before its policy is a key that briefly had whatever the
default allows. The secret is returned once.

Verify against the real S3 API before handing it over — a policy that reads correctly can
still be shadowed by ownership, and **wait ~30s after setting it** or you will be probing the
previous policy:

```bash
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
# An array, not a string: zsh does not word-split an unquoted $var, so the
# `S3='aws ...'` form you would write in bash silently becomes "command not found".
S3=(aws --endpoint-url https://s3.uk.io.cloud.ovh.net --region uk s3api)
"${S3[@]}" put-object      --bucket dev-rgis-ar --key uploads/probe.txt --body /dev/null   # 200
"${S3[@]}" get-object      --bucket dev-rgis-ar --key uploads/probe.txt /dev/null          # 403
"${S3[@]}" list-objects-v2 --bucket dev-rgis-ar                                            # 403
"${S3[@]}" delete-object   --bucket dev-rgis-ar --key uploads/probe.txt                    # 403
"${S3[@]}" put-object      --bucket dev-rgis-ar --key elsewhere/probe.txt --body /dev/null # 403
```

The `get-object` line is the one that matters: it is the check that catches trap 3, and it
passes only because of the preset's `Deny`.

## Develop

```bash
pnpm dev            # tsdown --watch
pnpm test           # vitest
pnpm typecheck
pnpm lint
pnpm format
```

## License

MIT
