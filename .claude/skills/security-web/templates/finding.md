# Finding report format

Every reported issue uses this shape. No exploit path → label it
**Observation**, not Finding, and skip Severity.

---

### [SEVERITY] Short title (vuln class)

- **Severity:** Critical | High | Medium | Low — and the one assumption
  that makes it that (e.g. "assumes the route is unauthenticated, which it
  is — no auth middleware on this path").
- **Location:** `path/to/file.ts:42` (and the sink/source if split across
  files).
- **Class:** XSS / IDOR / SSRF / injection / authz / secret-exposure / …
- **Exploit:** concrete walkthrough. Who the attacker is, the exact
  request/input they send, what they get. A real payload, not "could be
  abused". If you can't write this, it's an Observation.
- **Fix:** the minimal change, with the corrected snippet. Reference the
  rule (`SKILL.md` rule N) and the secure default
  (`templates/…`) — don't invent a one-off if a standard fix exists.
- **Confidence:** High (traced) | Medium (likely, unverified path) |
  needs-confirmation (and what to check).

---

### Example

### [High] Invoice IDOR via `:id` (authz / IDOR)

- **Severity:** High — any authenticated user can read any other tenant's
  invoice; ownership is never checked.
- **Location:** `src/routes/invoices.ts:31` (query), guard at `:24`.
- **Class:** Broken object-level authorization (IDOR).
- **Exploit:** Log in as a normal user, `GET /api/invoices/9001` with a
  guessed/incremented id. The query is `findUnique({ where: { id } })`
  with no tenant scope, so it returns invoice 9001 regardless of owner —
  cross-tenant financial data disclosure.
- **Fix:** scope the query to the session principal:
  `findFirst({ where: { id, orgId: session.orgId } })` and return 404 on
  miss (don't confirm existence). See `backend.md` §authz-idor, SKILL.md
  rule 1.
- **Confidence:** High — traced source→sink, no intervening policy check.
