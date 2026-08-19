export class OvhApiError extends Error {
  override readonly name = "OvhApiError";
  readonly status: number;
  /**
   * The `X-Ovh-QueryID` header. OVH support asks for this first on every ticket,
   * and it is the only handle on a request once it has left the process.
   */
  readonly queryId: string | undefined;
  /** OVH's own error class, e.g. `Client::Forbidden`, `Client::NotFound`. */
  readonly errorClass: string | undefined;
  readonly errors: unknown;

  constructor(
    message: string,
    opts: {
      status: number;
      queryId?: string | undefined;
      errorClass?: string | undefined;
      errors?: unknown;
    },
  ) {
    super(message);
    this.status = opts.status;
    this.queryId = opts.queryId;
    this.errorClass = opts.errorClass;
    this.errors = opts.errors;
  }
}

/** Thrown when a write path is reached while OVH_ALLOW_WRITES is off. */
export class WritesDisabledError extends Error {
  override readonly name = "WritesDisabledError";

  constructor(what: string) {
    super(
      `${what} is a write operation, but writes are disabled. ` +
        `Set OVH_ALLOW_WRITES=1 to enable mutating tools.`,
    );
  }
}
