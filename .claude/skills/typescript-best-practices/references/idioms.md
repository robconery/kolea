# TypeScript Idioms — full reference

Each section: **intent**, a **bad** example, the **idiomatic** version,
**notes**, and **when it is over-engineering**.

---

## §1 Prefer `unknown` over `any`; narrow before use

**Intent:** `any` disables the type checker for everything it touches and
spreads silently. `unknown` is the type-safe "I don't know yet" — you must
narrow it before use, so the check happens at the boundary.

```ts
// ❌ bad — `any` infects every downstream use
function parse(json: string): any {
  return JSON.parse(json);
}
const total = parse(input).order.total * 1.1; // no error, blows up at runtime
```

```ts
// ✅ idiomatic — force a narrowing decision at the boundary
function parse(json: string): unknown {
  return JSON.parse(json);
}

function isOrder(v: unknown): v is { total: number } {
  return typeof v === "object" && v !== null && "total" in v
    && typeof (v as Record<string, unknown>).total === "number";
}

const data = parse(input);
if (!isOrder(data)) throw new AppError("INVALID_ORDER", "bad payload");
const total = data.total * 1.1; // safe
```

**Notes:** ban `any` via `@typescript-eslint/no-explicit-any`. For genuinely
generic pass-through code use generics (`<T>`), not `any`. `unknown` is
correct for `JSON.parse`, `catch` bindings, and external input.

**Over-engineering:** narrowing throwaway script glue, or test fixtures
where the shape is asserted right there — `as` is acceptable in tests.

---

## §2 String-literal unions instead of `enum`

**Intent:** TS `enum` emits runtime code, has surprising numeric semantics,
and `const enum` breaks under isolated modules / bundlers. A union of string
literals is zero-cost, debuggable (the value *is* the label), and
JSON-friendly.

```ts
// ❌ bad
enum Status { Active, Disabled }      // values are 0,1 — meaningless in logs/db
```

```ts
// ✅ idiomatic
type Status = "active" | "disabled";

// when you need the runtime list too, derive both from one source:
const STATUSES = ["active", "disabled"] as const;
type Status2 = (typeof STATUSES)[number]; // "active" | "disabled"
```

**Notes:** `as const` array is the single source of truth for "the type"
*and* "the iterable list" — no drift. Use an `as const` object map when you
need named keys with stable values.

**Over-engineering:** none for app code. `enum` is occasionally justified
only when matching an external numeric protocol — even then a `const` map
is usually clearer.

---

## §3 Discriminated unions to make illegal states unrepresentable

**Intent:** Optional fields that are "only set sometimes" let contradictory
states compile. A tagged union ties each shape to a discriminant so the
compiler enforces which fields exist.

```ts
// ❌ bad — loading+error+data all optional; every combination is "valid"
interface State { loading: boolean; data?: User; error?: Error; }
```

```ts
// ✅ idiomatic
type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: User }
  | { status: "error"; error: Error };

function render(s: State) {
  switch (s.status) {
    case "idle": return "—";
    case "loading": return "spinner";
    case "success": return s.data.name;   // s.data exists only here
    case "error": return s.error.message; // s.error exists only here
  }
}
```

See `templates/discriminated-union.ts`. Pair with §5 for exhaustiveness.

**Over-engineering:** a struct with independent optional fields that
genuinely *are* independent (e.g. an address with optional `line2`) — that
is not a state machine; leave it.

---

## §4 Branded (nominal) types for un-swappable primitives

**Intent:** TypeScript is structural: `userId: string` and `orderId:
string` are interchangeable, so they get swapped at call sites. A brand
adds a phantom tag that only a smart constructor can produce.

```ts
type UserId = string & { readonly __brand: "UserId" };
const UserId = (raw: string): UserId => {
  if (!raw) throw new Error("empty UserId");
  return raw as UserId;
};

function getUser(id: UserId) { /* ... */ }
getUser("o_123");            // ❌ compile error — plain string
getUser(UserId("u_123"));    // ✅
```

Full helper in `templates/branded-type.ts`.

**Over-engineering:** branding every string. Reserve it for IDs, money,
units, and other primitives whose accidental mix-up is a real, costly bug
class.

---

## §5 Exhaustiveness checking with `never`

**Intent:** Make the compiler fail when a new union member is added but a
`switch`/`if` chain isn't updated.

```ts
function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}

function area(s: Shape): number {
  switch (s.kind) {
    case "circle": return Math.PI * s.r ** 2;
    case "square": return s.side ** 2;
    default: return assertNever(s); // adding "triangle" → compile error here
  }
}
```

**Notes:** prefer `switch` returning a value so every arm must produce the
result type. `assertNever` is also a runtime guard against malformed data.

**Over-engineering:** never; this is cheap insurance and belongs on every
exhaustive union handler.

---

## §6 `as const` and `satisfies` for config/literals

**Intent:** `satisfies` validates a value against a type *without widening*
it — you keep the precise literal types and still get the constraint check.

```ts
// ❌ bad — `: Config` widens `port` to number, loses key autocomplete
const config: Record<string, number> = { port: 8080 };

// ✅ idiomatic
const config = {
  port: 8080,
  host: "localhost",
} satisfies Record<string, string | number>;

config.port;  // type 8080 (literal), checked, autocompleted
```

**Notes:** `as const` deep-freezes types to literals & `readonly`; combine
with `satisfies` to keep literals *and* enforce a shape.

**Over-engineering:** plain mutable locals don't need either.

---

## §7 Return a `Result<T, E>` for expected failures

**Intent:** Exceptions are for *unexpected* faults. "Validation failed",
"not found", "insufficient funds" are expected control flow — model them in
the return type so callers must handle them and the type system tracks them.

```ts
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

function withdraw(acct: Account, amt: Money): Result<Account, "INSUFFICIENT"> {
  if (amt.gt(acct.balance)) return { ok: false, error: "INSUFFICIENT" };
  return { ok: true, value: acct.debit(amt) };
}

const r = withdraw(a, m);
if (!r.ok) return reply(400, r.error); // compiler forces this branch
use(r.value);
```

Full helpers (`ok`, `err`, `map`, `mapError`, `unwrap`) in
`templates/result.ts`.

**Over-engineering:** truly unrecoverable invariants (programmer error,
"this should never happen") — `throw` an `AppError` there; don't thread a
`Result` through 10 layers that all just propagate it.

---

## §8 Type the `catch`, narrow the error

**Intent:** Under `useUnknownInCatchVariables` (on with `strict`) the catch
binding is `unknown`. Don't cast it — narrow it.

```ts
try {
  await save();
} catch (e) {
  if (e instanceof AppError) return handle(e);
  if (e instanceof Error) log.error(e.message, { stack: e.stack });
  else log.error("non-error thrown", { value: String(e) });
  throw e; // rethrow what you can't handle
}
```

See `templates/app-error.ts` for a serializable error hierarchy with
`toJSON`/`toString`.

**Over-engineering:** none. Swallowing errors or `catch (e: any)` is the
anti-pattern.

---

## §9 Immutability by default

**Intent:** Shared mutable objects cause action-at-a-distance bugs. Make
the type say "you may not mutate this".

```ts
function totalize(items: readonly LineItem[]): Money { /* can't push/splice */ }

interface User {
  readonly id: UserId;
  readonly email: Email; // identity fields never reassigned
}

const DEFAULTS = Object.freeze({ retries: 3 }); // runtime + compile guard
```

**Notes:** `readonly` is compile-time only; `Object.freeze` adds a runtime
guarantee for true constants. Prefer returning new objects (`{...o, x}`)
over in-place mutation in domain code.

**Over-engineering:** deep-freezing large hot-path data structures, or
making every local `readonly`. Apply at module/domain boundaries.

---

## §10 One null convention; lean on `?.` and `??`

**Intent:** Mixing `null` and `undefined` doubles every absence check.
Pick one for "absent" (TS leans `undefined`; APIs/DBs often `null`) and
normalize at the boundary.

```ts
const name = user.profile?.displayName ?? "Anonymous"; // not `|| ` — keeps "" / 0
function find(id: Id): User | undefined { /* absence is undefined */ }
```

**Notes:** `??` only falls back on `null`/`undefined`; `||` also falls back
on `""`, `0`, `false` — usually a bug. Enable
`strictNullChecks` (part of `strict`).

**Over-engineering:** none; this is a baseline convention.

---

## §11 No floating promises

**Intent:** An un-awaited promise that rejects becomes an unhandled
rejection and the error is invisible. Every promise is awaited, returned,
or explicitly `void`-ed with a comment.

```ts
await sendEmail(u);                       // ✅ awaited
return repo.save(o);                      // ✅ returned
void analytics.track("evt").catch(noop);  // ✅ deliberate fire-and-forget

const [a, b] = await Promise.all([fa(), fb()]); // concurrent, not sequential awaits
```

**Notes:** enable `@typescript-eslint/no-floating-promises`. Don't `await`
in a loop when calls are independent — use `Promise.all`.

**Over-engineering:** none.

---

## §12 Derive types with utility types

**Intent:** Hand-copied object shapes drift from their source. Derive them.

```ts
type User = { id: UserId; email: Email; passwordHash: string };

type PublicUser = Omit<User, "passwordHash">;
type UserPatch  = Partial<Pick<User, "email">>;
type UsersById  = Record<UserId, User>;
type CreateUser = Omit<User, "id">;
```

**Notes:** also `Parameters`, `ReturnType`, `Awaited`, `NonNullable`,
`Exclude`/`Extract`. Derive *down* from the canonical type; don't build the
canonical type up from fragments.

**Over-engineering:** chains so deep (`Partial<Pick<Omit<...>>>`) that a
named explicit type would read better — name it.

---

## §13 Validate at the boundary; never cast external data

**Intent:** `JSON.parse`, `req.body`, env vars, DB rows are `unknown`. A
cast (`as User`) is a lie the compiler believes. Validate, then the type is
*earned*.

```ts
function assertIsCreateUser(v: unknown): asserts v is CreateUser {
  if (typeof v !== "object" || v === null) throw new AppError("BAD_INPUT", "not an object");
  const o = v as Record<string, unknown>;
  if (typeof o.email !== "string") throw new AppError("BAD_INPUT", "email required");
}
```

**Notes:** for non-trivial schemas use a runtime validation library (Zod,
Valibot, ArkType) that infers the static type from the schema — single
source of truth, no hand-written guard drift. Hand guards (see
`templates/type-guards.ts`) are fine for small/internal shapes.

**Over-engineering:** validating data you fully control and that never
crosses a process/IO boundary.

---

## §14 `interface` vs `type` vs `class`

- **`type`** — default for unions, intersections, mapped/conditional
  types, function types, and most object shapes.
- **`interface`** — public object/contract that may be `implements`-ed, or
  that benefits from declaration merging (rare in app code). Slightly
  better error messages and extension ergonomics for object contracts.
- **`class`** — when you need identity, invariants enforced in a
  constructor, behavior bundled with data, or instances (`instanceof`).
  Classes here **must** implement `toString()` and `toJSON()` — see
  `references/tostring-tojson.md`.

```ts
type Result<T, E> = Ok<T> | Err<E>;          // unions → type
interface Repository<T> { save(x: T): Promise<void>; } // contract → interface
class Money { /* invariants + behavior + toString/toJSON */ } // class
```

**Rule of thumb:** reach for `type`; switch to `interface` for an
implement-able contract; use `class` only when an instance with behavior
earns its keep. Don't model a pure data bag as a class.

**Over-engineering:** a class with only public fields and no
methods/invariants — that's a `type`/`interface`.
