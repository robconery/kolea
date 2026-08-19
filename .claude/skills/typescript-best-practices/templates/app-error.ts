/**
 * Typed, serializable error hierarchy.
 *
 * - One base class so `catch` can narrow with a single `instanceof`.
 * - A stable string `code` for programmatic handling (don't switch on
 *   `message` — that's human text and will change).
 * - `toJSON()` / `toString()` per the project convention: safe to log and
 *   to put on an API response without leaking internals or secrets.
 */

export interface AppErrorJSON {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  /** Safe, structured detail — never secrets/PII. Optional. */
  readonly context?: Readonly<Record<string, unknown>>;
}

export class AppError extends Error {
  readonly code: string;
  readonly context?: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    options?: { cause?: unknown; context?: Record<string, unknown> },
  ) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;          // correct subclass name
    this.code = code;
    this.context = options?.context;
    Object.setPrototypeOf(this, new.target.prototype); // fix instanceof
  }

  /** Machine shape — what a logger / API serializes. No stack, no secrets. */
  toJSON(): AppErrorJSON {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.context ? { context: this.context } : {}),
    };
  }

  /** Human shape — one line for log messages and `${err}`. */
  toString(): string {
    return `${this.name}[${this.code}]: ${this.message}`;
  }
}

// --- Domain subclasses (map cleanly to e.g. HTTP status at the edge) -------

export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("VALIDATION", message, { context });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super("NOT_FOUND", `${resource} not found`, { context: { resource, id } });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("CONFLICT", message, { context });
  }
}

// --- Narrowing helper for `catch (e: unknown)` -----------------------------

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

// --- Usage -----------------------------------------------------------------
//
//   try {
//     await repo.save(order);
//   } catch (e) {
//     if (isAppError(e)) {
//       log.warn(e.toJSON());            // structured, redacted
//       return reply(statusFor(e.code), e.toJSON());
//     }
//     log.error("unexpected", { value: String(e) });
//     throw e;                           // rethrow what we can't handle
//   }
