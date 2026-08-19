# Functions over Application Code (plpgsql only)

Set-based logic and integrity rules belong next to the data, not scattered
across every service that touches it. A function is a tested, versioned,
single-source API the database enforces; reimplementing it in three
languages is how the rules drift.

The house rule: **business and integrity logic lives in `plpgsql`
functions, invoked by the application.** `plpgsql` only — no
`language sql` snippets sprinkled around, no rules stranded in app code.

## Why `plpgsql`, and why *only* `plpgsql`

- One language for every function means one mental model, one debugging
  story, one place reviewers look. A codebase that mixes `language sql`,
  `language plpgsql`, and app-side logic has the rule in three dialects.
- `plpgsql` has the control flow, exceptions, and `RAISE` you need to fail
  loudly and meaningfully. A `language sql` one-liner can't validate and
  reject; it just computes.
- The cost (a `language sql` expression can sometimes inline/optimize
  slightly better) is real but small, and not worth a polyglot schema.
  Consistency wins. If a specific hot path proves it needs `language sql`,
  that is a measured, commented deviation — not the default.

## House style

Every function declares its contract explicitly:

```sql
CREATE OR REPLACE FUNCTION place_order(
  p_customer_id int,
  p_items       jsonb            -- [{ "product_id": 1, "quantity": 2 }, ...]
) RETURNS int
LANGUAGE plpgsql
VOLATILE                          -- it writes; say so
SECURITY INVOKER                  -- runs as caller; SECURITY DEFINER only with a reason
SET search_path = public, pg_temp -- pin it; never trust the caller's path
AS $$
DECLARE
  v_order_id int;
BEGIN
  -- 1. validate arguments; fail loud and specific
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'place_order: customer_id is required'
      USING errcode = 'check_violation';
  END IF;
  IF jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'place_order: at least one item is required'
      USING errcode = 'check_violation';
  END IF;

  -- 2. do the work as a set, not a loop
  INSERT INTO orders (customer_id) VALUES (p_customer_id)
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (order_id, product_id, quantity, unit_cents)
  SELECT v_order_id,
         (i->>'product_id')::int,
         (i->>'quantity')::int,
         p.price_cents
  FROM   jsonb_array_elements(p_items) AS i
  JOIN   products p ON p.id = (i->>'product_id')::int;

  RETURN v_order_id;
END;
$$;
```

Rules embodied above:

- **`CREATE OR REPLACE`**, always. Functions are versioned by migrations;
  every change is a full redefinition in a migration file, reviewed like
  any DDL. Never edit a function in place in production.
- **Declare volatility** (`IMMUTABLE`/`STABLE`/`VOLATILE`) honestly. The
  planner trusts it; lying causes wrong results.
- **`SET search_path`** on every function. An unpinned `search_path` is a
  privilege-escalation vector, especially with `SECURITY DEFINER`.
- **`SECURITY INVOKER` by default.** `SECURITY DEFINER` only with a
  written reason — it runs as the function owner and is a classic
  injection target.
- **Validate arguments first, `RAISE EXCEPTION` with a specific message
  and `errcode`.** The function defends its own contract so every caller,
  in every language, gets the same enforced rule. This is the whole point.
- **Set-based body, not row loops.** A `FOR ... LOOP` doing one
  `INSERT`/`UPDATE` per iteration is the most common `plpgsql`
  anti-pattern. Express it as one statement over a set; loop only for
  genuinely procedural work.
- **Naming:** `verb_noun`, parameters prefixed `p_`, locals `v_` — so the
  body never shadows a column name (a notorious `plpgsql` bug class).

## What belongs in a function

- Multi-row / multi-table operations that must be atomic and consistent
  (`place_order`, `transfer_funds`, `archive_user`).
- Invariants that must hold regardless of which service writes — pair the
  function with a `CHECK`/constraint so the rule holds even if someone
  bypasses the function.
- Computations reused by many queries (define once, call everywhere).

## What does *not* belong in a function

- Trivial single-row CRUD the app does fine with parameterized SQL.
  Functions are for rules and sets, not a stored-procedure wrapper around
  every `INSERT`.
- Orchestration that calls external systems (email, HTTP). The database
  coordinates data; it does not make network calls.
- Presentation/formatting. That is the application's job.

## Constraints are not optional just because a function exists

A function is the *front door*; constraints are the *walls*. Enforce the
rule both ways: the function gives a good error message and does the
set-based work; the `CHECK`/`UNIQUE`/FK guarantees the invariant even if a
migration, a backfill script, or a careless `psql` session skips the
function.

## When to deviate

- A proven hot path where `language sql` measurably wins and needs no
  validation: allowed, with a comment stating the measurement.
- Logic that genuinely belongs in the app (workflow across services,
  user-specific presentation, anything needing network I/O): keep it in
  the app — this rule is about *data* logic, not all logic.
