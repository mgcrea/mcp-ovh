// OVH's storage payloads carry a deliberate context bomb: every
// `cloud.StorageContainer` and `cloud.StorageContainerList` embeds a deprecated
// `objects[]` array holding EVERY object in the bucket. A bucket with 50k
// objects would return megabytes of JSON from what looks like a one-line "list
// my buckets" call. `stripObjects` removes it everywhere, and the bucket tools
// additionally send `noObjects=true` so it is never generated server-side.

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Apply a summarizer across an array, passing non-arrays through untouched. */
export const summarizeEach = <T>(value: unknown, fn: (item: Rec) => T): unknown =>
  Array.isArray(value) ? value.filter(isRecord).map(fn) : value;

/** Drop the deprecated `objects[]` array from a container payload. */
export const stripObjects = (container: Rec): Rec => {
  const { objects: _objects, ...rest } = container;
  return rest;
};

export const summarizeBucket = (bucket: Rec): Rec => ({
  name: bucket.name,
  region: bucket.region,
  // The owner matters more than it looks: an S3 policy is a NO-OP against the
  // bucket owner, who always holds FULL_CONTROL via ACL.
  ownerId: bucket.ownerId,
  objectsCount: bucket.objectsCount,
  objectsSize: bucket.objectsSize,
  createdAt: bucket.createdAt,
  virtualHost: bucket.virtualHost,
  arn: bucket.arn,
});

export const summarizeObject = (object: Rec): Rec => ({
  key: object.key,
  size: object.size,
  lastModified: object.lastModified,
  etag: object.etag,
  storageClass: object.storageClass,
  ...(object.versionId !== undefined ? { versionId: object.versionId } : {}),
  ...(object.isLatest !== undefined ? { isLatest: object.isLatest } : {}),
  ...(object.isDeleteMarker !== undefined ? { isDeleteMarker: object.isDeleteMarker } : {}),
  ...(object.isCommonPrefix !== undefined ? { isCommonPrefix: object.isCommonPrefix } : {}),
});

export const summarizeUser = (user: Rec): Rec => ({
  id: user.id,
  username: user.username,
  description: user.description,
  status: user.status,
  creationDate: user.creationDate,
  roles: Array.isArray(user.roles)
    ? user.roles.filter(isRecord).map((role) => role.name)
    : user.roles,
});

export const summarizeRegion = (region: Rec): Rec => ({
  name: region.name,
  type: region.type,
  status: region.status,
  continentCode: region.continentCode,
  datacenterLocation: region.datacenterLocation,
  availabilityZones: region.availabilityZones,
});

/**
 * OVH returns an S3 policy as a JSON *string* inside `{"policy": "..."}`. Parse
 * it so the agent sees a real document instead of an escaped blob, keeping the
 * raw text alongside for anything that needs to round-trip it verbatim.
 */
export const parsePolicyRaw = (value: unknown): Rec => {
  if (!isRecord(value) || typeof value.policy !== "string") return { policy: value };
  try {
    return { policy: JSON.parse(value.policy) as unknown, raw: value.policy };
  } catch {
    return { policy: value.policy };
  }
};
