# SOLID Principles — TypeScript Reference

Each section: intent → smell → bad example → refactor → TypeScript notes →
when applying it is over-engineering.

---

## S — Single Responsibility Principle (SRP)

**Intent:** A module should have one reason to change. Group code by the
actor/stakeholder it serves, not by superficial similarity.

**Smell:** A class mixes business rules, persistence, and presentation; a
change to the report format risks breaking save logic; the class name contains
"and" or "Manager".

### Bad

```ts
class Invoice {
  constructor(public items: { name: string; cents: number }[]) {}

  total(): number {
    return this.items.reduce((s, i) => s + i.cents, 0);
  }

  // Persistence concern
  save(): void {
    const db = new Database("postgres://...");
    db.execute("INSERT INTO invoices ...", { total: this.total() });
  }

  // Presentation concern
  toHtml(): string {
    return `<h1>Invoice</h1><p>Total: $${this.total() / 100}</p>`;
  }
}
```

Three reasons to change: tax rules, the database, the HTML template.

### Refactor

```ts
class Invoice {
  constructor(public readonly items: { name: string; cents: number }[]) {}
  total(): number {
    return this.items.reduce((s, i) => s + i.cents, 0);
  }
}

class InvoiceRepository {
  constructor(private readonly db: Database) {}
  save(invoice: Invoice): Promise<void> {
    return this.db.execute("INSERT INTO invoices ...", { total: invoice.total() });
  }
}

class InvoiceHtmlRenderer {
  render(invoice: Invoice): string {
    return `<h1>Invoice</h1><p>Total: $${(invoice.total() / 100).toFixed(2)}</p>`;
  }
}
```

`Invoice` now only changes when invoice *math* changes.

**TypeScript notes:** SRP applies to modules/files too — a `utils.ts` that
grows unrelated helpers is the same smell. Split by consumer.

**Over-engineering when:** the "responsibilities" always change together, or
splitting produces anemic one-method classes that just forward calls. A small
script's `main()` doing three things is fine.

---

## O — Open/Closed Principle (OCP)

**Intent:** Add new behavior by adding code, not by editing existing,
tested code.

**Smell:** Every new variant adds a branch to a growing `switch` that several
functions must each be updated to handle.

### Bad

```ts
type Shape =
  | { kind: "circle"; r: number }
  | { kind: "square"; side: number };

function area(s: Shape): number {
  switch (s.kind) {
    case "circle": return Math.PI * s.r ** 2;
    case "square": return s.side ** 2;
    // adding "triangle" forces edits here AND in perimeter(), draw(), ...
  }
}
```

### Refactor (polymorphism)

```ts
interface Shape {
  area(): number;
}

class Circle implements Shape {
  constructor(private r: number) {}
  area() { return Math.PI * this.r ** 2; }
}

class Square implements Shape {
  constructor(private side: number) {}
  area() { return this.side ** 2; }
}

// Adding Triangle = new class, zero edits to existing code.
const total = (shapes: Shape[]) => shapes.reduce((s, x) => s + x.area(), 0);
```

**TypeScript notes:** The discriminated-union + `switch` form is *not always*
an OCP violation. If the variant set is genuinely closed and you want the
compiler to force every consumer to handle new cases, keep the union and add
an exhaustiveness check:

```ts
function assertNever(x: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(x)}`);
}
// default: return assertNever(s);  ← compile error when a case is missed
```

Use polymorphism when variants are open-ended and added by other teams; use
the checked union when they are closed and you *want* central updates.

**Over-engineering when:** you add a strategy interface and a registry for a
two-branch condition that has not changed in a year. Wait for the second
real reason to extend.

---

## L — Liskov Substitution Principle (LSP)

**Intent:** Code written against a base type must work unchanged with any
subtype. Subtypes may not strengthen preconditions or weaken postconditions.

**Smell:** A subclass overrides a method to throw `NotSupported`, return
`null`, or quietly do nothing; callers need `instanceof` checks before using
a "subtype".

### Bad

```ts
class Rectangle {
  constructor(protected w: number, protected h: number) {}
  setWidth(w: number) { this.w = w; }
  setHeight(h: number) { this.h = h; }
  area() { return this.w * this.h; }
}

class Square extends Rectangle {
  setWidth(w: number) { this.w = w; this.h = w; }   // surprises callers
  setHeight(h: number) { this.w = h; this.h = h; }
}

function resizeAndCheck(r: Rectangle) {
  r.setWidth(4);
  r.setHeight(5);
  console.assert(r.area() === 20); // fails for Square
}
```

`Square` is not substitutable for a mutable `Rectangle`.

### Refactor

Drop the false "is-a" inheritance; model the real invariant.

```ts
interface Shape { area(): number; }

class Rectangle implements Shape {
  constructor(private w: number, private h: number) {}
  area() { return this.w * this.h; }
}

class Square implements Shape {
  constructor(private side: number) {}
  area() { return this.side ** 2; }
}
```

**TypeScript notes:** TypeScript checks method *signatures* structurally
(parameter bivariance aside) but cannot enforce behavioral contracts — LSP
violations compile fine. Watch for: overrides that throw, narrowed accepted
inputs, return types that callers must re-check, and optional fields a
subtype leaves unset.

**Over-engineering when:** there is no inheritance/implements relationship at
all — LSP only governs substitutable hierarchies. Don't invent base classes
to "apply LSP."

---

## I — Interface Segregation Principle (ISP)

**Intent:** No client should depend on methods it does not use. Prefer
several small role interfaces over one general-purpose one.

**Smell:** Implementers throw or stub methods; a change to an unused method
forces a recompile/redeploy of clients that never call it.

### Bad

```ts
interface Machine {
  print(doc: string): void;
  scan(doc: string): string;
  fax(doc: string): void;
}

class SimplePrinter implements Machine {
  print(doc: string) { /* ok */ }
  scan(): string { throw new Error("not supported"); } // LSP+ISP smell
  fax(): void { throw new Error("not supported"); }
}
```

### Refactor

```ts
interface Printer { print(doc: string): void; }
interface Scanner { scan(doc: string): string; }
interface Fax { fax(doc: string): void; }

class SimplePrinter implements Printer {
  print(doc: string) { /* ... */ }
}

class AllInOne implements Printer, Scanner, Fax {
  print(doc: string) { /* ... */ }
  scan(doc: string) { return "..."; }
  fax(doc: string) { /* ... */ }
}

// Consumers depend only on what they need:
function batchPrint(p: Printer, docs: string[]) {
  docs.forEach((d) => p.print(d));
}
```

**TypeScript notes:** Structural typing makes ISP nearly free — a function
can declare the exact slice it needs inline, no named interface required:

```ts
function batchPrint(p: { print(d: string): void }, docs: string[]) { /* ... */ }
```

The narrowest form: pass the function itself — `(doc: string) => void`.

**Over-engineering when:** you split a cohesive interface whose methods are
always implemented and consumed together. Segregate along *real* client
boundaries, not for symmetry.

---

## D — Dependency Inversion Principle (DIP)

**Intent:** High-level policy should not depend on low-level details. Both
depend on abstractions. The abstraction is owned by the high-level module.

**Smell:** Business logic imports and `new`s a concrete database/HTTP/SDK
client; unit tests need a real DB or network; swapping the vendor means
editing core logic.

### Bad

```ts
import { PostgresClient } from "pg-vendor";

class SignupService {
  private db = new PostgresClient(process.env.DB_URL!); // hard-wired detail

  async register(email: string) {
    await this.db.query("INSERT INTO users ...", [email]);
  }
}
```

Untestable without Postgres; vendor lock-in in the policy layer.

### Refactor (constructor injection)

```ts
// Abstraction owned by the high-level module:
interface UserStore {
  add(email: string): Promise<void>;
}

class SignupService {
  constructor(private readonly users: UserStore) {}
  async register(email: string) {
    await this.users.add(email);
  }
}

// Detail depends on the abstraction:
class PostgresUserStore implements UserStore {
  constructor(private db: PostgresClient) {}
  add(email: string) { return this.db.query("INSERT INTO users ...", [email]); }
}

// Composition root wires concretions (only place that knows the vendor):
const service = new SignupService(new PostgresUserStore(new PostgresClient(url)));

// Tests inject a fake:
const service = new SignupService({ add: async () => {} });
```

**TypeScript notes:**
- The abstraction can be a function type, not an interface:
  `constructor(private addUser: (email: string) => Promise<void>) {}`.
- Keep the interface defined next to its *consumer*, not next to the DB
  implementation — that is what "inversion" means.
- Avoid heavy DI containers until the wiring genuinely hurts; manual
  construction in `main.ts` is usually enough.

**Over-engineering when:** the dependency is stable, owned by you, and has no
alternate implementation or test seam (e.g. a pure date-math helper). An
interface with exactly one implementation that you'll never fake adds
indirection for nothing.

---

## Quick review checklist

- [ ] Does each class have a single stakeholder/reason to change? (S)
- [ ] Can a new variant be added without editing tested code — or is the
      central switch intentional and exhaustiveness-checked? (O)
- [ ] Can every subtype stand in for its base without caller `instanceof`
      checks or surprise throws? (L)
- [ ] Do implementers ever stub/throw methods they don't need? (I)
- [ ] Does policy depend on an abstraction it owns, with concretions wired at
      the composition root? (D)
- [ ] Is each abstraction earning its keep (≥2 impls or a real test seam),
      not added on speculation?
