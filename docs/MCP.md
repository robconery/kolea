# 🤖 Driving Kōlea from an agent

The Worker serves an MCP server: **144 tools**, 4 resources and 4 prompts covering the
whole mailer, so an agent can cut segments, draft and send broadcasts, build sequences,
publish posts, read campaign performance, and reconcile Stripe. There are two ways to
connect, and both reach the same tools behind the same guards.

## 🔗 By URL

Add `https://<admin host>/mcp` to an MCP client that can sign in (OAuth 2.1 with PKCE).
The client registers itself, your browser opens a consent page on the console, and you
press **Connect**. No key is copied anywhere.

- The consent page sits behind Cloudflare Access. Your approval there is the
  authentication.
- A connection is **read-only by default**: it can read your subscribers, broadcasts,
  sequences, sales and stats, and every tool that changes anything refuses it.
- Tick **Allow changes** on the consent page and it can create, edit and delete, the same
  as an admin key. Sending still needs the send switch and a preflight.
- Access tokens last an hour and renew themselves. **Connected apps** lists each app, when
  it was last used, and disconnects it at once. To change a read-only connection, disconnect
  it and approve it again with the box ticked.

In production this needs Access Bypass apps for `/mcp`, `/.well-known/*`,
`/oauth/register`, `/oauth/token` and `/oauth/revoke`. `/mcp/*` does not cover `/mcp`.
Never bypass `/oauth/authorize`: it is the consent page. See [`INSTALL.md`](INSTALL.md).

## 🔑 By path secret and key

```bash
# 1. a path secret (this is what makes the endpoint exist at all)
openssl rand -hex 24                      # → put in .dev.vars as MCP_PATH_SECRET

# 2. an admin-scoped key: make one on System → Agents & keys, or "Seed demo data" prints one

# 3. point Claude Code at it
claude mcp add --transport http --scope local \
  --header "Authorization: Bearer $KOLEA_KEY" \
  kolea "http://localhost:8787/mcp/$MCP_PATH_SECRET"
```

**Three gates, cheapest first.** An unguessable path secret compared in constant time
(a miss returns `404`, not `403`, because a URL nobody guessed should look like nothing
is there), then an `admin`-scoped bearer key (`send` and `read` keys can't reach
it), then per-tool guards. A key connection is never read-only.

## 🎚 The two switches

**System → Agents & keys** holds two switches. Both start **off**, and only that screen
can change them: no tool and no key can.

| Switch | While it is off, these refuse |
|---|---|
| **Agents may send mail** | `broadcast_send`, `broadcast_send_test`, `broadcast_schedule`, `broadcast_resume`, `sequence_activate`, `sequence_tick`, `purchase_mail_send`, `form_resend_replies`, `undelivered_send_again` |
| **Agents may make sensitive changes** | `subscriber_delete`, `subscriber_import_csv`, `suppression_remove`, `sequence_rejoin_person`, `apikey_create`, `webhook_create`, `webhook_update`, `webhook_delete` |

With sending off an agent can still draft, preview and preflight everything, and a person
sends. Turning a switch off takes effect on the next call, with no redeploy.

`MCP_ALLOW_SEND="false"` in the Worker config is a hard off: it forces agent sending off
whatever the switch says. Any other value, or none, leaves the switch in charge. The var
can no longer turn sending on.

## 🧾 Preflights and the record

**Irreversible sends need a preflight.** `broadcast_send` refuses without a token from
`broadcast_preflight`: single-use, 10-minute expiry, invalidated by any edit to the
content or the audience. The same holds for `sequence_activate`, `broadcast_resume` and
`undelivered_send_again`, each with a preflight tool of its own.

Every call lands in `mcp_calls`, including the refusals, with the key or the connected
app that made it. `log_search` and `log_types` read the same event log as the Logs page.

## 🧰 Tools added since 0.1.0

35 tools, on top of the 109 in 0.1.0:

| Family | Tools |
|---|---|
| Stored transactional templates | `template_list`, `template_get`, `template_create`, `template_update`, `template_delete` |
| Outbound webhooks | `webhook_list`, `webhook_create`, `webhook_update`, `webhook_delete`, `webhook_deliveries` |
| Sequence templates | `sequence_template_list`, `_get`, `_create`, `_update`, `_delete`, `_use` |
| Undelivered mail | `undelivered_list`, `undelivered_preflight`, `undelivered_send_again`, `form_resend_replies` |
| Broadcasts | `broadcast_resume_preflight`, `broadcast_resume`, `broadcast_revise` |
| Sequences | `sequence_exit_set`, `sequence_exit_remove` |
| Site | `post_update`, `member_list`, `topic_list`, `topic_update`, `theme_list`, `theme_activate` |
| People and sales | `subscriber_unsubscribe`, `sale_get` |
| The event log | `log_search`, `log_types` |

There are no tools for custom field definitions, Launch Studio, importers, the team or
the two switches. Custom field **values** are set with `subscriber_upsert`, and
`kolea://merge-tags` lists the fields.

Agents should read `kolea://conventions` before touching consent. Scoped unsubscribe is
not the shape anything trained on normal ESPs expects, and getting it wrong is exactly
the failure this project was built to avoid.

📖 [`ARCHITECTURE.md`](ARCHITECTURE.md) is written as an agent's reference:
the invariants, the code map, the traps, and where to add things.

---

[Back to the README](../README.md)
