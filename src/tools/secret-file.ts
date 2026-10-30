import { lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { z } from "zod";

/**
 * Every tool that mints or reveals a secret takes this. A tool result lands in
 * the assistant's transcript — and from there in logs, history and whatever the
 * client syncs — so the only way to keep a live secret out of it is to never
 * put it in the result at all.
 */
export const secretFileArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Absolute path of a NEW file to write the secret to (JSON, mode 0600) instead of returning " +
      "it, so it stays out of this conversation. The parent directory must exist; an existing " +
      "file is never overwritten. Must sit inside OVH_SECRET_DIR when that is set.",
  );

export const SECRET_FILE_NOTE =
  "The secret was written to `secretFile` and is NOT in this result. Read it from that file.";

const errorCode = (err: unknown): string | undefined =>
  err instanceof Error && "code" in err ? String(err.code) : undefined;

const isInside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);

/**
 * Validate a `secretFile` BEFORE the OVH call, so a bad path refuses up front
 * instead of minting a credential that then has nowhere to go.
 *
 * Returns the path to write: the parent resolved through `realpath`, so the
 * containment check and the write both act on the directory that really holds
 * the file, not on a symlink that could point anywhere. The final component is
 * checked with `lstat`, which sees a symlink (even a dangling one) as existing.
 */
export const checkSecretFile = async (
  secretFile: string,
  secretDir: string | undefined,
): Promise<string> => {
  if (!isAbsolute(secretFile)) {
    throw new Error(`\`secretFile\` must be an absolute path, got '${secretFile}'.`);
  }
  const resolved = resolve(secretFile);
  const name = basename(resolved);
  if (!name) {
    throw new Error(`\`secretFile\` must name a file, got '${secretFile}'.`);
  }

  let parent: string;
  try {
    parent = await realpath(dirname(resolved));
  } catch (err) {
    if (errorCode(err) === "ENOENT") {
      throw new Error(
        `The directory of \`secretFile\` does not exist: '${dirname(resolved)}'. Create it first.`,
        { cause: err },
      );
    }
    throw err;
  }
  if (!(await stat(parent)).isDirectory()) {
    throw new Error(`The parent of \`secretFile\` is not a directory: '${dirname(resolved)}'.`);
  }

  if (secretDir !== undefined) {
    if (!isAbsolute(secretDir)) {
      throw new Error(`OVH_SECRET_DIR must be an absolute path, got '${secretDir}'.`);
    }
    let allowed: string;
    try {
      allowed = await realpath(resolve(secretDir));
    } catch (err) {
      if (errorCode(err) === "ENOENT") {
        throw new Error(`OVH_SECRET_DIR does not exist: '${secretDir}'.`, { cause: err });
      }
      throw err;
    }
    if (!isInside(parent, allowed)) {
      throw new Error(
        `\`secretFile\` must be inside OVH_SECRET_DIR ('${secretDir}'); '${secretFile}' ` +
          `resolves to '${join(parent, name)}'.`,
      );
    }
  }

  const target = join(parent, name);
  try {
    await lstat(target);
  } catch (err) {
    if (errorCode(err) === "ENOENT") return target;
    throw err;
  }
  throw new Error(`\`secretFile\` already exists: '${target}'. It is never overwritten.`);
};

/**
 * Write the secret material, AFTER the OVH call has minted it.
 *
 * `wx` is O_CREAT|O_EXCL: it refuses an existing file and will not follow a
 * symlink planted after checkSecretFile ran. A failure here usually means a
 * credential now exists that nobody has the secret of, so `aftermath` says what
 * was minted and how to revoke it — ids only, never the secret.
 */
export const writeSecretFile = async (
  target: string,
  data: Record<string, unknown>,
  aftermath: string,
): Promise<void> => {
  let created = false;
  try {
    const handle = await open(target, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  } catch (err) {
    // Never leave a half-written secret behind.
    if (created) await unlink(target).catch(() => undefined);
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Writing \`secretFile\` '${target}' failed (${reason}). The secret is not in this ` +
        `result. ${aftermath}`,
      { cause: err },
    );
  }
};
