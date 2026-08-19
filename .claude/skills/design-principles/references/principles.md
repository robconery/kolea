# Design Principles — TypeScript Reference

Each section: intent → smell → bad example → refactor → TypeScript notes →
when applying it is over-engineering. Principles covered by `solid-principles`
or `gof-patterns` are referenced, not repeated.

---

## Coupling — keep it loose; measure it with connascence

**Intent:** Minimize what one module must know about another so a change stays
local. "Coupling" is vague on its own; **connascence** makes it actionable —
two pieces of code are connascent if changing one forces a change in the other.
Weak/visible forms are tolerable; strong/distant forms are debt.

Strength ladder (weak → strong): **Name** → **Type** → **Meaning** →
**Position** → **Algorithm** → **Timing/Execution-order**. Rule of thumb:
weaken the form, or shrink its distance to a single module.

**Smell:** Editing one function forces ripple edits elsewhere; callers must
pass arguments in a magic order; two modules must agree on an undocumented
convention (`-1 means "not found"`).

### Bad

```ts
// Connascence of Position (arg order) + Meaning (magic numbers)
function createUser(name: string, age: number, role: number, active: number) {
  // role: 0 admin, 1 member  | active: 0 no, 1 yes  (callers must "just know")
}
createUser("Ada", 36, 0, 1);
```

### Refactor

```ts
// Connascence of Name only — strongest coupling reduced to a shared shape
type Role = "admin" | "member";
function createUser(input: {
  name: string;
  age: number;
  role: Role;
  active: boolean;
}) {}

createUser({ name: "Ada", age: 36, role: "admin", active: true });
```

**TypeScript notes:** Options objects convert connascence of position → name.
Branded/literal types convert connascence of meaning → type (checked by the
compiler). Keep connascence of algorithm (e.g. a hash both sides must compute
identically) inside one module exposing a function — never duplicated across a
boundary.

**Over-engineering when:** two modules genuinely *are* one concept; forcing an
interface between them just to "decouple" adds an indirection with one
implementation (that is also a YAGNI violation). Some coupling is the design.

---

## Cohesion — group what changes and is used together

**Intent:** A module's elements should belong together. Highest value is
*functional* cohesion (everything serves one well-defined job). Avoid
*coincidental* ("misc utils") and *temporal* ("things we happen to do at
startup") cohesion.

**Smell:** `helpers.ts` / `utils.ts` imported by half the codebase for
unrelated reasons; a class where no method uses the same fields as any other.

### Bad

```ts
// Coincidental cohesion: unrelated functions sharing a file by accident
export function formatCurrency(n: number) { /* ... */ }
export function retry<T>(fn: () => Promise<T>) { /* ... */ }
export function isValidEmail(s: string) { /* ... */ }
```

### Refactor

```ts
// money.ts
export function formatCurrency(n: number) { /* ... */ }
// async.ts
export function retry<T>(fn: () => Promise<T>) { /* ... */ }
// email.ts
export function isValidEmail(s: string) { /* ... */ }
```

A telling test: if you can describe the module without "and", it is cohesive.

**TypeScript notes:** Cohesion shows up in imports — a module imported for one
of its five exports by every caller signals it should be split. Co-locate
types with the behavior that owns them rather than a global `types.ts`.

**Over-engineering when:** splitting yields single-line modules with more
import noise than logic, or a "package per function" structure. Cohesion is
about *related change*, not minimal file size. (Module-level SRP overlaps here
— see `solid-principles`; this entry adds the cohesion *taxonomy*.)

---

## DRY — one authoritative source for each piece of knowledge

**Intent:** Each business rule, formula, or fact has exactly one
representation. Duplication of *knowledge* means a change must be made in N
places and one will be missed.

**Smell:** The same tax rule, validation regex, or status-transition table
copied into several files; a bug fixed in one copy but not the others.

### Bad

```ts
// Knowledge "free shipping over $50" duplicated and already drifting
function cartSummary(c: Cart) {
  const free = c.total >= 50;       // dollars
}
function checkout(c: Cart) {
  const free = c.total >= 5000;     // cents — silently inconsistent
}
```

### Refactor

```ts
const FREE_SHIPPING_CENTS = 5_000;
export const qualifiesForFreeShipping = (totalCents: number) =>
  totalCents >= FREE_SHIPPING_CENTS;
```

### The counter-rule (false DRY)

```ts
// These look identical TODAY but encode unrelated decisions.
// Coupling them means a change to one breaks the other. Keep separate.
const isEligibleForTrial = (u: User) => u.country === "US" && u.age >= 18;
const canPurchaseAlcohol = (u: User) => u.country === "US" && u.age >= 18;
```

**TypeScript notes:** DRY *types* with utility types (`Pick`, `Omit`,
`ReturnType`, `as const` + `typeof`) and a single source-of-truth schema
(e.g. infer types from a Zod schema) instead of hand-syncing interfaces.

**Over-engineering when:** you deduplicate incidental similarity. Apply the
**Rule of Three**: tolerate the second occurrence; extract on the third, once
the shared *concept* is proven. Premature abstraction is harder to undo than
duplication.

---

## YAGNI — You Aren't Gonna Need It

**Intent:** Don't add capability, configurability, or generality until a
concrete, present requirement demands it. Speculative flexibility is carrying
cost (more code, more tests, more coupling) for unproven benefit.

**Smell:** Config flags with one value; an interface with one implementation
and no test double; "we might support Postgres *and* Mongo" plumbing when only
Postgres ships; generic `<T>` parameters always instantiated as one type.

### Bad

```ts
// One payment provider exists. This abstracts three that don't.
interface PaymentGateway { charge(c: Charge): Promise<Receipt>; }
class StripeGateway implements PaymentGateway { /* ... */ }
// + GatewayFactory, GatewayConfig, GATEWAY_REGISTRY ... all for Stripe-only
```

### Refactor

```ts
// Ship the concrete thing. Introduce the interface when the SECOND
// provider (or a real test-double need) actually arrives.
export async function charge(c: Charge): Promise<Receipt> { /* Stripe */ }
```

**TypeScript notes:** YAGNI directly tensions with OCP/DIP from
`solid-principles` — resolve it by *deferring*: structural typing means you can
extract the interface later in minutes without touching call sites, so there is
no cost to waiting.

**Over-engineering when:** the future need is essentially certain and the
reversal is expensive (public API shape, persisted data schema, wire formats).
YAGNI is about *speculative* needs, not known irreversibility — those warrant
upfront design.

---

## KISS — Keep It Simple

**Intent:** Among designs that meet the requirement, prefer the one with the
fewest moving parts and the lowest reader cognitive load. Complexity must buy
something measurable.

**Smell:** A metaprogramming/decorator/generic-constraint maze where a plain
function or `switch` would do; a "framework" for a three-case problem.

### Bad

```ts
const dispatch = (cmds: Record<string, (...a: any[]) => unknown>) =>
  new Proxy({}, { get: (_t, k: string) => cmds[k] ?? (() => { throw 0; }) });
```

### Refactor

```ts
function handle(cmd: "start" | "stop") {
  return cmd === "start" ? start() : stop();
}
```

**TypeScript notes:** Reach for the simplest construct first: union + `switch`
before a class hierarchy, a closure before a Strategy class, `as const` before
an enum. Escalate only when the simple version demonstrably hurts.

**Over-engineering when:** "simple" becomes a 400-line `switch` or copy-paste
that a known pattern would tame. KISS is fewest *essential* parts, not fewest
abstractions at any cost — see `gof-patterns` for when indirection earns its
keep.

---

## Separation of Concerns

**Intent:** Different concerns (transport, business policy, persistence,
presentation) live in different modules/layers that can be reasoned about,
tested, and replaced independently.

**Smell:** A request handler that parses HTTP, applies business rules, builds
SQL, and formats the response in one function — untestable without a server
and a database.

### Bad

```ts
app.post("/orders", async (req, res) => {
  if (!req.body.items?.length) return res.status(400).end();   // transport
  const total = req.body.items.reduce((s, i) => s + i.price, 0); // policy
  await db.query("INSERT INTO orders ...", [total]);             // persistence
  res.send(`<b>Total $${total / 100}</b>`);                      // presentation
});
```

### Refactor

```ts
// policy (pure, unit-testable)
export const orderTotal = (items: Item[]) => items.reduce((s, i) => s + i.price, 0);
// persistence
export const saveOrder = (db: Db, total: number) => db.query("INSERT ...", [total]);
// transport — thin, just wiring
app.post("/orders", async (req, res) => {
  const items = parseItems(req.body);          // validation/transport
  const total = orderTotal(items);             // policy
  await saveOrder(db, total);                  // persistence
  res.json({ total });                         // presentation
});
```

**TypeScript notes:** Keep the policy layer free of `req`/`res`/SDK types so it
is pure and fast to test. This is SRP "in the large"; `solid-principles` covers
the class-level case — the addition here is the *layering* lens.

**Over-engineering when:** a CRUD endpoint with no business logic is split into
controller→service→repository→mapper for three lines of code. Layer count
should track domain complexity, not ceremony.

---

## Encapsulation / Information Hiding

**Intent:** Hide *how* an object represents its state; expose *what* it can do.
Callers depend on behavior, so the representation can change freely.

**Smell:** Public mutable fields; getters/setters that expose every field;
callers reaching into nested structures and maintaining invariants the object
should own.

### Bad

```ts
class Wallet {
  balance = 0;                      // anyone can set it negative
}
const w = new Wallet();
w.balance -= 100;                   // invariant ("never negative") not enforced
```

### Refactor

```ts
class Wallet {
  #balanceCents = 0;                // true runtime privacy
  get balanceCents() { return this.#balanceCents; }
  deposit(cents: number) {
    if (cents <= 0) throw new RangeError("deposit must be positive");
    this.#balanceCents += cents;
  }
  withdraw(cents: number) {
    if (cents > this.#balanceCents) throw new Error("insufficient funds");
    this.#balanceCents -= cents;
  }
}
```

**TypeScript notes:** Prefer `#field` over `private` when callers must not
bypass it — `private` is erased at runtime and reachable via `any`/JS. Return
`readonly T[]` / `Readonly<T>` (or copies) from accessors so callers can't
mutate internal collections.

**Over-engineering when:** wrapping a pure data transfer object (DTO) /
config / JSON payload in getters and setters that add no invariant. Data with
no rules can stay a plain typed object.

---

## Tell, Don't Ask

**Intent:** Tell objects what to do; don't extract their state to make the
decision for them. Logic that uses an object's data belongs *with* that data.

**Smell:** `if (obj.x && obj.y) { obj.z = ... }` outside the object; the same
state-poking decision repeated at every call site.

### Bad

```ts
if (account.status === "active" && account.balanceCents >= amount) {
  account.balanceCents -= amount;        // caller enforces the rule
} else {
  throw new Error("cannot debit");
}
```

### Refactor

```ts
class Account {
  debit(amount: number) {                // object enforces its own rule
    if (this.status !== "active") throw new Error("inactive account");
    if (this.balanceCents < amount) throw new Error("insufficient funds");
    this.balanceCents -= amount;
  }
}
account.debit(amount);
```

**TypeScript notes:** This is the force behind GoF Strategy/State/Command (see
`gof-patterns`). Apply it to domain/service objects. Deliberately *do not*
apply it to view models / API DTOs that React or serializers must read — those
are legitimately "ask" objects.

**Over-engineering when:** it pushes unrelated rendering/formatting logic into
a domain entity just to avoid a getter, hurting cohesion. Querying state for
display is fine; *deciding domain behavior* from outside is not.

---

## Law of Demeter (Principle of Least Knowledge)

**Intent:** A method should talk only to: itself, its parameters, objects it
creates, and its direct fields. Don't navigate through one object to reach
another ("don't talk to strangers").

**Smell:** Train wrecks: `order.getCustomer().getAddress().getZip()`. The
caller is now coupled to the entire object graph's shape.

### Bad

```ts
function shippingZone(order: Order) {
  return zoneFor(order.getCustomer().getAddress().getCountry()); // 3 hops
}
```

### Refactor

```ts
class Order {
  shippingCountry(): string {            // expose the answer, not the graph
    return this.customer.address.country;
  }
}
function shippingZone(order: Order) {
  return zoneFor(order.shippingCountry());
}
```

**TypeScript notes:** Optional chaining (`a?.b?.c`) makes train wrecks
*null-safe* but not *decoupled* — null-safety hides the design smell, it does
not fix it. Add an intention-revealing method on the owning object instead.

**Over-engineering when:** applied to data structures and DTOs you *own* and
that are stable (e.g. `config.server.port`, a parsed JSON tree). Demeter
targets *behavioral* objects whose internal structure should stay private, not
plain nested data.

---

## Composition over Inheritance

**Intent:** Build behavior by assembling small parts (delegation) rather than
extending a base class. Reserve inheritance for genuine "is-substitutable-for"
relationships (and then it must obey LSP — see `solid-principles`).

**Smell:** Deep class hierarchies; a subclass that overrides a parent method to
throw/no-op; needing behavior from two unrelated parents.

### Bad

```ts
class Bird { fly() { /* ... */ } }
class Penguin extends Bird {
  fly() { throw new Error("penguins can't fly"); }   // LSP violation
}
```

### Refactor

```ts
interface Mover { move(): void; }
const walks: Mover = { move() { /* waddle */ } };
const flies: Mover = { move() { /* fly */ } };

class Bird {
  constructor(private readonly locomotion: Mover) {}
  move() { this.locomotion.move(); }                 // behavior injected
}
const penguin = new Bird(walks);
```

**TypeScript notes:** Favor interface + delegation, or just function
parameters. The patterns that operationalize this — Strategy, Decorator,
Bridge — are in `gof-patterns`; this entry is the *general principle* and the
inheritance smell test.

**Over-engineering when:** a shallow, stable hierarchy with true substitution
(e.g. `class HttpError extends Error`) is replaced by composition machinery.
Inheritance is a tool, not a sin; it is wrong only when it forces
non-substitutable subtypes.

---

## Program to an Interface, not an Implementation

**Intent:** Depend on the *role* a collaborator plays (a contract), not its
concrete class, so implementations can be swapped (real ↔ fake ↔ alternative)
without touching consumers.

**Smell:** Business logic that imports and `new`s a concrete SDK/client; tests
that need a live database/network because the type is the concrete class.

### Bad

```ts
import { S3Client } from "@aws-sdk/client-s3";
class ReportService {
  private s3 = new S3Client({});                 // welded to AWS
  async publish(r: Report) { /* uses this.s3 */ }
}
```

### Refactor

```ts
type BlobStore = { put(key: string, body: Uint8Array): Promise<void> };

class ReportService {
  constructor(private readonly store: BlobStore) {}   // depends on the role
  async publish(r: Report) { await this.store.put(r.key, r.bytes); }
}
// composition root injects an S3-backed BlobStore; tests inject an in-memory one
```

**TypeScript notes:** Structural typing means the contract can be a one-line
`type` (often a single function), and concrete classes satisfy it *without*
`implements`. This principle is the practical sibling of DIP/ISP — see
`solid-principles` for the dependency-direction and segregation arguments; the
contribution here is "define the seam as the *narrowest role*."

**Over-engineering when:** there is exactly one implementation, no test-double
need, and the dependency is trivial/stable (`Math`, `JSON`, a pure util). An
interface with one impl and one caller is also a YAGNI violation.

---

## Command–Query Separation (CQS)

**Intent:** Every method is either a **command** (changes state, returns
`void`/ack) or a **query** (returns data, no observable side effects) — never
both. Queries become safe to call freely, reorder, cache, and reason about.

**Smell:** A getter that mutates (lazy init with side effects callers don't
expect); `save()` that also mutates and returns the entity; `pop()`-style
methods that both read and remove (a known, accepted CQS exception).

### Bad

```ts
class Counter {
  #n = 0;
  next(): number { return ++this.#n; }     // query-looking, but mutates
}
const c = new Counter();
log(c.next(), c.next());                    // result depends on call order
```

### Refactor

```ts
class Counter {
  #n = 0;
  get value(): number { return this.#n; }   // query: pure
  increment(): void { this.#n += 1; }       // command: no return
}
```

**TypeScript notes:** Name commands as verbs (`activate`, `enqueue`) returning
`void` or `Promise<void>`; name queries as nouns/`get*`/`is*`/`has*` and keep
them side-effect free. Mark query-only inputs `readonly` to back the promise
with the type system.

**Over-engineering when:** idiomatic, well-understood combined operations
(`array.pop()`, `map.delete()` returning a boolean, `INSERT ... RETURNING id`).
CQS is a default to make side effects visible, not a prohibition on every
useful return value.

---

## Principle of Least Astonishment (POLA)

**Intent:** A component should behave the way its name, signature, and context
lead a reasonable caller to expect. Surprise is a defect even when "correct."

**Smell:** `getUser()` that creates a user if missing; a `==`-style helper that
mutates an argument; a sort that isn't stable when the name implies it; a
boolean param that silently flips behavior at call sites.

### Bad

```ts
function getConfig(): Config {
  if (!cached) cached = loadFromDiskAndMutateGlobalEnv();  // surprising I/O
  return cached;
}
function parseDate(s: string, strict = false) { /* default is lenient?! */ }
```

### Refactor

```ts
function loadConfig(): Config { /* name signals work/I/O happens */ }
function getCachedConfig(): Config | undefined { /* pure, honest */ }

function parseDate(s: string, opts: { strict: boolean }) { /* explicit */ }
```

**TypeScript notes:** Encode expectations in the signature: replace boolean
flags with named options or distinct functions; let names advertise cost
(`load*`/`fetch*` may be slow/async, `get*`/`is*` should be cheap & pure);
make impossible inputs unrepresentable so callers can't be surprised.

**Over-engineering when:** chasing "zero surprise" with hyper-explicit APIs
nobody asked for, or breaking strong platform conventions in the name of your
own intuition. The baseline is the *ecosystem's* expectations, not a personal
one.

---

## Fail Fast

**Intent:** Detect invalid state/inputs at the earliest, outermost boundary and
stop loudly — close to the cause — instead of limping on with bad data that
corrupts state and surfaces as a confusing error far away.

**Smell:** Defensive `?.`/`|| {}`/`?? 0` smeared through deep layers to survive
inputs that should have been rejected at entry; a `NaN`/`undefined` that
travels three modules before exploding.

### Bad

```ts
function priceWithTax(order: any) {
  const t = order?.items?.reduce?.((s: number, i: any) => s + (i?.price ?? 0), 0) ?? 0;
  return t * (1 + (order?.taxRate ?? 0));   // silently returns 0, hiding the bug
}
```

### Refactor

```ts
import { z } from "zod";
const Order = z.object({
  items: z.array(z.object({ price: z.number().nonnegative() })).nonempty(),
  taxRate: z.number().min(0).max(1),
});

function priceWithTax(raw: unknown) {
  const order = Order.parse(raw);           // throws AT THE BOUNDARY, precisely
  const sub = order.items.reduce((s, i) => s + i.price, 0);
  return sub * (1 + order.taxRate);         // core logic trusts its inputs
}
```

**TypeScript notes:** Validate `unknown` at every trust boundary (HTTP body,
env vars, JSON, message payloads) and convert it to a precise type once;
internal code then relies on the type system instead of re-checking. Make
illegal states unrepresentable (discriminated unions, branded types) so "fail
fast" happens at *compile* time. Throw/assert on broken invariants rather than
returning a degraded default.

**Over-engineering when:** re-validating already-validated, internally-typed
data at every function (paranoia tax), or crashing a long-running consumer on
*recoverable* per-item errors that should be isolated and logged. Fail fast at
*boundaries*; degrade gracefully for expected, recoverable runtime conditions.
