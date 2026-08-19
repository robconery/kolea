/**
 * Branded (nominal) types — zero runtime cost.
 *
 * TypeScript is structurally typed, so `string` IDs of different meaning are
 * interchangeable and get swapped at call sites. A brand adds a phantom tag
 * that only a "smart constructor" can attach, so the type carries proof it
 * was validated.
 */

declare const brand: unique symbol;

/** `Brand<string, "UserId">` is assignable from a plain string ONLY via a constructor. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

// --- Example: UserId -------------------------------------------------------

export type UserId = Brand<string, "UserId">;

/** Smart constructor: the single place a UserId can be created. Validate here. */
export function UserId(raw: string): UserId {
  if (!/^u_[a-z0-9]{6,}$/.test(raw)) {
    throw new Error(`Invalid UserId: ${JSON.stringify(raw)}`);
  }
  return raw as UserId;
}

// --- Example: a branded number with units ---------------------------------

export type Cents = Brand<number, "Cents">;

export function Cents(n: number): Cents {
  if (!Number.isInteger(n)) throw new Error(`Cents must be an integer, got ${n}`);
  return n as Cents;
}

// --- Usage -----------------------------------------------------------------
//
//   function getUser(id: UserId): User { ... }
//   getUser("u_abc123");        // ❌ compile error: plain string
//   getUser(UserId("u_abc123")); // ✅
//
//   const total: Cents = Cents(1999);
//   const bad: Cents = 1999;     // ❌ compile error
//
// Reserve branding for primitives whose accidental mix-up is a real bug
// class (IDs, money, units, tokens) — do not brand every string.
