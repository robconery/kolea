# The `toString()` / `toJSON()` convention

**Rule: every class in this codebase implements both `toString()` and
`toJSON()`.** This page is the rationale, the contract, edge cases, and the
copy-ready pattern. Every file in `templates/` follows it.

## Why both, and why mandatory

| | `toJSON()` | `toString()` |
|---|---|---|
| Audience | machines (logs/JSON, APIs, persistence) | humans (log lines, errors, `${}`) |
| Called by | `JSON.stringify` automatically | string coercion / template literals |
| Returns | a plain serializable object | a short string |
| Failure if absent | leaks private fields or emits `{}`/`undefined` | `"[object Object]"` |

The deeper reason is **information hiding**. A class's internal fields are
an implementation detail. Default serialization (`JSON.stringify(instance)`)
couples every consumer — your API, your logs, your DB — to that internal
shape, so renaming a private field silently changes the wire format or
leaks a secret. `toJSON()` makes the *external representation* an explicit,
reviewable contract that is decoupled from internal storage. `toString()`
does the same for human-facing identity. Making them mandatory means the
contract is never accidental.

## The contract

**`toJSON()`**
- Returns a **new plain object/array/primitive**, never `this`, never a
  class instance (recurse into `.toJSON()` of nested objects — or just
  return them and let `JSON.stringify` recurse).
- **Deterministic and stable**: it is an API. Treat field
  renames/removals as breaking changes.
- **Redacts secrets**: passwords, tokens, full card numbers, PII never
  appear. Redaction lives here so it cannot be forgotten at call sites.
- Normalizes non-JSON types: `Date → ISO string`, `bigint → string`,
  `Map → object/array`, `Set → array`, `undefined → omit the key`.
- Total: never throws.

**`toString()`**
- Short, single line, human-readable, includes the identifier that makes
  the instance findable (e.g. ``Order(id=o_123, total=$42.00)``).
- Never dumps the whole object — that's `toJSON()`'s job.
- Total: never throws.
- Conventionally `` `ClassName(...)` `` so it's greppable in logs.

## Copy-ready pattern

```ts
class Order {
  readonly #id: OrderId;          // private — must not leak by default
  readonly #total: Money;
  #customerEmail: Email;

  // ... constructor / behavior ...

  toJSON(): OrderJSON {
    return {
      id: this.#id,
      total: this.#total.toJSON(),        // recurse into value objects
      // email intentionally redacted from the default wire shape
    };
  }

  toString(): string {
    return `Order(id=${this.#id}, total=${this.#total})`;
  }
}

// The serialized shape is itself a named, reviewed type:
interface OrderJSON {
  readonly id: string;
  readonly total: { amount: string; currency: string };
}
```

`JSON.stringify(order)` → uses `toJSON()` automatically.
`` `processing ${order}` `` / `console.log(`${order}`)` → uses
`toString()`. `console.log(order)` (no coercion) still shows internals in
Node — for log pipelines log `order.toJSON()` or a string explicitly.

## Edge cases

- **Nested instances:** return them from `toJSON()` and let
  `JSON.stringify` call *their* `toJSON()`, or call `.toJSON()` yourself if
  the field is private and you need the plain value before stringify.
- **Circular references:** `toJSON()` must break the cycle — emit an id
  reference (`{ parentId }`), not the parent object.
- **`Date`:** `Date#toJSON()` already yields ISO; for `toString()` format
  intentionally rather than relying on the locale default.
- **`bigint`:** `JSON.stringify` throws on raw `bigint` — `toJSON()` must
  convert to `string` (or `number` if safe).
- **Secrets:** never in either method. If a debug dump of secrets is ever
  needed, that is a separate, explicitly-named method
  (`toDebugString()`), never `toString`/`toJSON`.
- **Round-tripping:** if the object must reconstruct from its JSON, pair
  `toJSON()` with a static `fromJSON(json): ClassName` and keep their
  shapes in sync via the shared `XxxJSON` type.

## Testing the contract

```ts
test("Order serialization is stable and redacted", () => {
  const o = Order.create(/* ... */);
  expect(JSON.parse(JSON.stringify(o))).toEqual({
    id: "o_123",
    total: { amount: "42.00", currency: "USD" },
  });
  expect(JSON.stringify(o)).not.toContain("@");      // email redacted
  expect(`${o}`).toBe("Order(id=o_123, total=$42.00 USD)");
});
```

Snapshot-test `toJSON()` so accidental shape changes fail loudly in
review — the serialized shape is a contract.

## Review checklist

- [ ] Class has both `toString()` and `toJSON()`.
- [ ] `toJSON()` returns a fresh plain object, typed by a named `XxxJSON`.
- [ ] No secrets/PII in either; non-JSON types normalized.
- [ ] `toString()` is short, single-line, and contains the identifier.
- [ ] Neither throws.
- [ ] If reconstructable: `static fromJSON` exists and shares the type.
- [ ] `toJSON()` shape is snapshot-tested.
