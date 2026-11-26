# 🤖 Driving Kōlea from an agent

The Worker serves an MCP server at `POST /mcp/<secret>`: more than **100 tools** covering the
whole mailer, so an agent can cut segments, draft and send broadcasts, build sequences,
publish posts, read campaign performance, and reconcile Stripe.

```bash
# 1. a path secret (this is what makes the endpoint exist at all)
openssl rand -hex 24                      # → put in .dev.vars as MCP_PATH_SECRET

# 2. an admin-scoped key: "Seed demo data" prints one, or use apikey_create

# 3. point Claude Code at it
claude mcp add --transport http --scope local \
  --header "Authorization: Bearer $KOLEA_KEY" \
  kolea "http://localhost:8787/mcp/$MCP_PATH_SECRET"
```

**Three gates, cheapest first.** An unguessable path secret compared in constant time
(a miss returns `404`, not `403`, because a URL nobody guessed should look like nothing
is there), then an `admin`-scoped bearer key (transactional `send` keys can't reach
it), then per-tool guards. Every call lands in `mcp_calls`, including the refusals.

**Irreversible sends need a preflight.** `broadcast_send` refuses without a token from
`broadcast_preflight`: single-use, 10-minute expiry, invalidated by any edit to the
content or the audience. Same for `sequence_activate`. On top of that, `MCP_ALLOW_SEND`
is `"false"` in production, so MCP can read and draft everything but cannot put mail on
the wire until you deliberately flip it. Flipping it back is the instant off-switch.

Agents should read `kolea://conventions` before touching consent. Scoped unsubscribe is
not the shape anything trained on normal ESPs expects, and getting it wrong is exactly
the failure this project was built to avoid.

📖 [`ARCHITECTURE.md`](ARCHITECTURE.md) is written as an agent's reference:
the invariants, the code map, the traps, and where to add things.

---

[Back to the README](../README.md)
