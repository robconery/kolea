# 🪄 AI writing help

Kōlea runs fine without AI, and that is the default. Add an
[OpenRouter](https://openrouter.ai) key and three helpers appear. Leave it out and
none of them render: no buttons, no links, and the `/ai/*` endpoints return 404.
The key is the only switch.

| Helper | Where it shows up | Default model | Typical cost |
|---|---|---|---|
| **Suggest a subject** | Under the subject line in the composer | `anthropic/claude-sonnet-5` | under 1 cent |
| **Clean this up** | Under the slop dial in the composer | `anthropic/claude-opus-5.5` | 2 to 10 cents |
| **Draft it for me** | "Make it yours" on any sequence template | `anthropic/claude-opus-5.5` | 20 to 40 cents per sequence |

None of them can send anything. A suggested subject fills in only when you click
it. A clean-up replaces the draft in the editor as one change, and ⌘Z brings yours
back. It rewrites prose only, so images, buttons, quotes, code and merge tags come
back untouched. A drafted sequence is created paused, and every mail opens with an
`[[ AI draft ]]` note. That note blocks activation until you have rewritten each mail
yourself.

### 🔑 Turning it on

1. Create a key at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys),
   and give it a credit limit while you're there.
2. Locally, add it to `.dev.vars`:

   ```bash
   OPENROUTER_KEY=sk-or-v1-...
   ```

3. In production, store it as a secret and redeploy:

   ```bash
   bunx wrangler secret put OPENROUTER_KEY --env production
   bun run deploy
   ```

To turn AI off again, delete the secret (`bunx wrangler secret delete OPENROUTER_KEY
--env production`) or remove the line from `.dev.vars`.

### 💸 Keeping the bill small

Every call is recorded in the `ai_calls` table, along with the cost OpenRouter
reports. Before each call, the month's total is checked against a cap, and once
the cap is reached every helper says so and stops. The cap is $10 unless you set
your own. The key's credit limit on OpenRouter is a second lock.

Optional settings, as vars or secrets:

```bash
AI_MONTHLY_BUDGET_USD=10                      # the monthly cap, in dollars
AI_MODEL_SUBJECT=anthropic/claude-sonnet-5    # any OpenRouter model id
AI_MODEL_CLEANUP=anthropic/claude-opus-5.5
AI_MODEL_SEQUENCE=anthropic/claude-opus-5.5
```

Any model on OpenRouter works if it supports structured outputs, because subject
suggestions and sequence drafts are requested as JSON. A cheaper model is a
reasonable choice for subjects. For clean-ups, a weaker model tends to swap one
stock phrase for another.

The writing guide the models get lives in `src/core/ai/style.ts`. It's plain text,
it's plain rules about readable prose, and it's the place to make the
output sound like you.

---

[Back to the README](../README.md)
