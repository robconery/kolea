---
name: postgres-dba
description: >-
  Opinionated PostgreSQL schema and database design conventions: snake_case
  naming, `id serial primary key` surrogate keys, compound primary keys for
  many-to-many junctions, NOT NULL foreign keys by default (nullable only with
  an explicit override), enums instead of excessive lookup tables, STORED
  generated columns for derived/searchable data, business logic in plpgsql
  functions instead of application code, and JSONB used as a document store
  alongside a relational spine. Use when designing or reviewing a Postgres
  schema, writing DDL/migrations, naming tables/columns/constraints, deciding
  enum vs lookup table, modeling many-to-many, choosing JSONB vs columns, or
  answering "what is the right Postgres way to do this" questions. Ships
  copy-ready DDL, function, and JSONB-document templates.
---

# PostgreSQL DBA — Opinionated Schema Design

The database is the system of record, not a dumb bucket behind an ORM.
Model integrity in the schema, push set-based logic into functions, and let
the application consume a clean, self-defending API. These conventions are
defaults with teeth: deviating is allowed, but only deliberately and with a
comment saying why.

## 🎯 Why: Design for Change

The goal of writing software is to be able to **change it safely** — and a
schema is the hardest thing in any system to change. Consistent naming,
surrogate keys, NOT NULL FKs, enums, and logic-in-functions exist so
migrations stay mechanical: you add a column, you don't reshape the world.
JSONB next to a relational spine lets the document side evolve without a
migration. Every rule here optimizes for the *next* migration being boring.

This skill is about *database design and SQL*. For TypeScript/app-layer
concerns use the language skills; this skill never defers integrity to the
application.

## How to use this skill

1. Match the task to a rule below or in the decision guide.
2. Open the matching `references/*.md` for the full rationale, the wrong
   way, the right way, and the explicit-override escape hatch.
3. Copy the closest file from `templates/` and adapt it — the templates
   already encode every convention here, so you start compliant.
4. Apply the rule unless you can state, in a comment in the DDL, the
   specific reason it does not apply here. "It was easier" is not a reason.

## The hard rules (non-negotiable defaults)

1. **Naming is `snake_case`, lowercase, unquoted, forever.** Tables plural
   (`orders`), columns singular (`shipped_at`), no reserved words, no
   `CamelCase`, no quoted identifiers in the schema. If you ever need to
   double-quote an identifier in normal queries, the name is wrong. See
   `references/naming.md`.

2. **Every base table has `id serial primary key`.** A synthetic key,
   always named `id`, is the row's identity. Natural keys get a `UNIQUE`
   constraint, never the primary key. Use `bigserial`/identity only when
   you have a concrete reason to expect >2.1B rows — and write that reason
   in a comment. See `references/keys.md`.

3. **Many-to-many uses a compound primary key, not a surrogate.** The
   junction table's primary key *is* `(left_id, right_id)`. No `id` column
   on a pure junction. Both columns are FKs and both are `NOT NULL`. See
   `references/keys.md`.

4. **Foreign keys are `NOT NULL` by default.** A nullable FK is a modeling
   claim ("this relationship is genuinely optional") and must carry an
   explicit `-- nullable-fk: <reason>` comment on the column. No comment,
   no nullable FK. Every FK declares `ON DELETE` behavior explicitly. See
   `references/keys.md`.

5. **Prefer an `enum` type over a lookup table** for small, stable,
   code-driven value sets (status, role, kind). Reach for a lookup table
   only when the set carries extra columns, is user-editable, or churns
   often — and the decision guide in `references/enums.md` says which.

6. **Derived data that you filter, sort, or search on is a `GENERATED
   ... STORED` column,** not an application concern and not a trigger.
   Don't store what you can compute for free; do store what you index. See
   `references/generated-columns.md`.

7. **Set-based and integrity logic lives in `plpgsql` functions,** invoked
   by the app, not reimplemented in every caller. `plpgsql` only — no
   `language sql` one-liners sprinkled around, no business rules stranded
   in application code. Functions are versioned via `CREATE OR REPLACE` in
   migrations. See `references/functions.md`.

8. **JSONB is a first-class document store, used on purpose.** A
   relational spine (keys, FKs, hot fields as generated columns) carries a
   `jsonb` body for open-ended or document-shaped data, GIN-indexed and
   `CHECK`-validated. Never `json`; always `jsonb`. See
   `references/jsonb.md`.

## Decision guide

| Situation | Rule | Reference |
|---|---|---|
| Naming a table, column, index, constraint, FK | Rule 1 | `references/naming.md` |
| Choosing a primary key | Rule 2 | `references/keys.md` |
| Modeling many-to-many | Rule 3 | `references/keys.md` |
| FK column — should it allow NULL? | Rule 4 (default no) | `references/keys.md` |
| `ON DELETE` behavior for an FK | Rule 4 (always explicit) | `references/keys.md` |
| Status / role / kind / type column | Rule 5 (enum first) | `references/enums.md` |
| Need to add/remove an enum value safely | — | `references/enums.md` |
| A column whose value is derived from others | Rule 6 | `references/generated-columns.md` |
| Full-text search column | Rule 6 (`tsvector` generated) | `references/generated-columns.md` |
| Business rule touching multiple rows/tables | Rule 7 | `references/functions.md` |
| Validation that must hold regardless of caller | Rule 7 + `CHECK` | `references/functions.md` |
| Open-ended attributes / document-shaped data | Rule 8 | `references/jsonb.md` |
| Querying or indexing inside a JSONB document | Rule 8 | `references/jsonb.md` |
| EAV / "custom fields" temptation | Rule 8 (use JSONB, not EAV) | `references/jsonb.md` |

## Templates

- `templates/schema.sql` — a reference schema demonstrating every rule:
  naming, `id serial primary key`, a compound-key junction, NOT NULL FKs
  with explicit `ON DELETE` and one annotated nullable-FK override, an enum
  in use, a generated column, and standard `created_at`/`updated_at`.
- `templates/function.sql` — the house style for a `plpgsql` function:
  signature, `SECURITY`/`volatility`/`search_path`, argument validation,
  set-based body, and the `CREATE OR REPLACE` migration pattern.
- `templates/jsonb-document.sql` — the hybrid pattern: relational spine +
  `jsonb` body, generated columns extracting hot fields, GIN index, a
  `CHECK` that validates document shape, and the canonical update idioms.
- `templates/migration.sql` — a transactional, reversible-by-design
  migration skeleton consistent with the function-versioning rule.

## What this skill will not do

- Bless `varchar(n)` as a length constraint — use `text` plus a `CHECK`.
- Bless `timestamp` without time zone — use `timestamptz`, always.
- Bless application-side cascade deletes, soft-FK "by convention", or
  ORM-managed referential integrity. The database enforces integrity.
- Bless triggers where a generated column or `CHECK` does the job.
- Bless EAV tables. Open-ended data is JSONB (Rule 8).
