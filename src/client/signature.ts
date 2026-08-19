import { createHash } from "node:crypto";

/**
 * OVH's application-key signature, kept pure so it can be pinned against a fixed
 * vector in tests.
 *
 *   X-Ovh-Signature: "$1$" + sha1hex(AS + "+" + CK + "+" + METHOD + "+" + URL + "+" + BODY + "+" + TS)
 *
 * Every part matters and OVH compares byte-for-byte:
 *  - URL is the FULL absolute URL including the query string, not the path.
 *  - BODY is the exact serialized request body, empty string when there is none.
 *  - TS is unix SECONDS, and must be within ~30s of OVH's own clock — hence the
 *    drift correction in `auth.ts`.
 */
export type SignatureInput = {
  applicationSecret: string;
  consumerKey: string;
  method: string;
  url: string;
  body: string;
  timestamp: number;
};

export const signRequest = (input: SignatureInput): string => {
  const parts = [
    input.applicationSecret,
    input.consumerKey,
    input.method.toUpperCase(),
    input.url,
    input.body,
    String(input.timestamp),
  ];
  return `$1$${createHash("sha1").update(parts.join("+")).digest("hex")}`;
};

/**
 * OVH's clock minus ours, in seconds. A machine whose clock is off by more than
 * ~30s fails *every* signed call with `Invalid signature`, which reads like a bad
 * secret; correcting for the delta turns that class of failure off entirely.
 */
export const clockDelta = (serverTimeSeconds: number, localMs: number): number =>
  serverTimeSeconds - Math.floor(localMs / 1000);
