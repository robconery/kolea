# SQLite *in* Production

The default assumption of this skill is Postgres in production. But SQLite
can be a perfectly good production database — for the right workload, with
the discipline below. This section is how to make that possible. It is not
permission to skip the analysis; it is the analysis.

## When SQLite-in-prod is appropriate

All of these should be true:

- **Single node.** One application process (or a small set on one box)
  owning one database file on a real, persistent, fsync-honoring disk —
  not a network filesystem, not an ephemeral container layer.
- **Read-heavy or modest write volume.** WAL gives unlimited concurrent
  readers but exactly **one writer at a time**. Hundreds of
  reads/sec/concurrent: fine. Sustained, highly-concurrent independent
  writers: that is what Postgres is for.
- **Writes are short.** A writer holds a global lock for the duration of
  its transaction. Long-running write transactions stall every other
  writer. Keep them milliseconds, not seconds.
- **Operational simplicity is a feature.** No DB server to run, patch, or
  scale; the database is a file you can copy. For edge/embedded/internal
  tools/single-tenant SaaS this is a genuine advantage.

If any is false, SQLite is the dev database and Postgres is production —
follow `portability.md` and stop here.

## Production connection settings

The dev pragma block plus server tuning (see `templates/db.production.ts`):

```ts
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA synchronous = NORMAL;');     // durable under WAL on good hardware
db.exec('PRAGMA wal_autocheckpoint = 1000;'); // pages; keep the WAL bounded
db.exec('PRAGMA cache_size = -65536;');       // ~64 MB page cache (negative = KiB)
db.exec('PRAGMA mmap_size = 268435456;');     // 256 MB memory-mapped I/O
db.exec('PRAGMA temp_store = MEMORY;');
```

`synchronous = NORMAL` under WAL loses *no committed transaction* on an
app crash; it can lose the last commit only on an OS/power loss without a
working fsync. If that is unacceptable, use `FULL` and accept the write
cost — decide deliberately and comment it.

## Single-writer discipline

This is the rule that makes SQLite-in-prod safe:

- **One `Database` instance for writes, process-wide.** Never a pool of
  writers against the file.
- **Wrap every write path in an `IMMEDIATE` transaction.** A deferred
  transaction takes the write lock lazily and can fail *mid-transaction*
  with `SQLITE_BUSY`; `BEGIN IMMEDIATE` acquires it up front so contention
  fails fast and cleanly (the helper is in the production template).
- **Keep write transactions tiny.** Do network/CPU work *before* opening
  the transaction; inside it, only the writes.
- `busy_timeout` handles brief contention by waiting; `IMMEDIATE` plus
  short transactions keeps that wait near zero.

Reads need none of this — under WAL they never block and are never blocked
by the writer.

## Durability & backups

A single file is a single point of failure. Pick one:

- **Litestream** (recommended for single node): streams the WAL
  continuously to S3-compatible storage; point-in-time restore, near-zero
  RPO, no app changes. This is the standard answer for SQLite-in-prod.
- **LiteFS** (Fly.io): a FUSE filesystem giving replicated SQLite with
  read replicas and failover. Use when you need HA/read-scale and accept
  its single-writer/primary model.
- **Snapshot backups** as a baseline regardless: `VACUUM INTO
  '/backups/app-<ts>.db'` produces a consistent copy without blocking
  readers (the production template exposes this as a scheduled hook). Plain
  `cp` of a live WAL database is **not** a valid backup.

Test restores. An untested backup is a hope, not a backup.

## Operational notes

- **WAL checkpointing:** `wal_autocheckpoint` keeps the `-wal` file
  bounded; run a periodic `PRAGMA wal_checkpoint(TRUNCATE);` in a
  low-traffic window if it still grows under sustained writes.
- **Disk:** local SSD/NVMe. Networked/`NFS` filesystems break SQLite's
  locking — data corruption, not just slowness. Containers must mount a
  real persistent volume; the writable container layer is not durable.
- **Migrations:** apply at deploy, not per-request. A schema-rebuild
  migration (drizzle-kit's SQLite strategy) takes the write lock for the
  rebuild — schedule it and expect brief write unavailability.
- **`STRICT` tables** still apply in prod; they are the cheapest
  protection against affinity bugs you have.
- **No network exposure.** SQLite is in-process; there is nothing to
  bind, authenticate, or firewall. That is part of why it's simple — keep
  it that way.

## Outgrowing it

The triggers to migrate to Postgres: write contention you can't shrink
(persistent `SQLITE_BUSY` despite short `IMMEDIATE` transactions), a need
for multiple writer nodes, or analytical/concurrent workloads the single
writer can't serve. Because the schema followed `portability.md`, that
migration is the mechanical cutover checklist there — which is exactly why
you keep these conventions even when SQLite *is* production.
