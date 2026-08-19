/**
 * Result<T, E> — model expected, recoverable failures in the return type
 * instead of throwing. Exceptions stay for *unexpected* faults.
 *
 * Why: the caller is forced by the compiler to handle the error branch, and
 * the set of possible errors is visible in the signature.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

// --- Constructors ----------------------------------------------------------

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

// --- Combinators -----------------------------------------------------------

export function map<T, U, E>(r: Result<T, E>, f: (v: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

export function mapError<T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F> {
  return r.ok ? r : err(f(r.error));
}

export function andThen<T, U, E>(
  r: Result<T, E>,
  f: (v: T) => Result<U, E>,
): Result<U, E> {
  return r.ok ? f(r.value) : r;
}

/** Escape hatch: throw if Err. Use at the top level / tests, not in libraries. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw r.error instanceof Error
    ? r.error
    : new Error(`unwrap on Err: ${JSON.stringify(r.error)}`);
}

export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/** Wrap a throwing call into a Result at an IO boundary. */
export async function fromPromise<T>(p: Promise<T>): Promise<Result<T, unknown>> {
  try {
    return ok(await p);
  } catch (e) {
    return err(e);
  }
}

// --- Usage -----------------------------------------------------------------
//
//   type WithdrawError = "INSUFFICIENT_FUNDS" | "ACCOUNT_FROZEN";
//
//   function withdraw(a: Account, amt: Money): Result<Account, WithdrawError> {
//     if (a.frozen) return err("ACCOUNT_FROZEN");
//     if (amt.gt(a.balance)) return err("INSUFFICIENT_FUNDS");
//     return ok(a.debit(amt));
//   }
//
//   const r = withdraw(acct, m);
//   if (!r.ok) return reply(409, r.error); // compiler forces this branch
//   persist(r.value);
