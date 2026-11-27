# 🪄 AI writing help

Kōlea runs fine without AI, and that is the default. Give it a key that can pay, either
an [OpenRouter](https://openrouter.ai) key for the install or your own key saved on
**System → AI**, and the helpers appear. Leave it out and the composer shows no AI
buttons, and the `/ai/*` endpoints return 404. A key that can pay is the only switch.

| Helper | Where it shows up | Default model | Typical cost |
|---|---|---|---|
| **Suggest a subject** | Under the subject line in the composer | `anthropic/claude-sonnet-5` | under 1 cent |
| **Clean this up** | Under the slop dial in the composer | `anthropic/claude-opus-5.5` | 2 to 10 cents |
| **Draft it for me** | "Make it yours" on any sequence template | `anthropic/claude-opus-5.5` | 20 to 40 cents per sequence |

Three more are covered below. Their cost depends on the length of what they read and
write, and every call shows up in the month's total.

| Helper | Where it shows up | Default model |
|---|---|---|
| **Ghostwriter** | "Ghostwriter" beside the draft in the composer, and **Ghostwriter takes** on a sequence | `anthropic/claude-opus-5.5` |
| **Reader council** | **Ask the council** beside a broadcast or a sequence step | `anthropic/claude-opus-5.5` |
| **Launch angle** | The copy step of **Money → Launch Studio** | `anthropic/claude-sonnet-5` |

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

### 🎛 Choosing the key and the models

**System → AI** decides which key pays and which model each helper uses.

**Who pays.** The install's `OPENROUTER_KEY`, as above, or your own OpenRouter,
Anthropic or OpenAI key. Paste your own key on the screen, then choose it under **Who
pays**. It is stored encrypted and never shown again, only its last four characters.
Give the key a spending limit with its provider too.

Saving a key needs the `AI_KEY_ENCRYPTION_SECRET` secret: 32 or more random
characters. `bun run setup` writes a local one. Without it the screen says so and
stores nothing. Change the secret and every saved key has to be pasted again.

```bash
bunx wrangler secret put AI_KEY_ENCRYPTION_SECRET --env production
```

**Models.** Each helper has its own picker. An OpenRouter key can use every model on
the list. An Anthropic key can use the Claude models, and an OpenAI key the GPT models.
A choice made here wins over an `AI_MODEL_*` variable, and the variable wins over the
default.

### 💸 Keeping the bill small

Every call is recorded in the `ai_calls` table with what it cost, whichever key paid.
OpenRouter reports the cost of each call. Anthropic and OpenAI report tokens only, so
those calls are estimated from list prices. Before each call, the month's total is
checked against a cap, and once the cap is reached every helper says so and stops. The
cap is $10 unless you set your own. The key's credit limit with its provider is a
second lock. The AI screen shows the month's spend against the cap.

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

### ✍️ Ghostwriter

The Ghostwriter drafts a mail in a voice you tune. Set the voice on **Mail →
Ghostwriter**:

- **Influences.** Six sliders, 0 for off to 5 for strong. The strongest sets the
  rhythm. It borrows how a writer writes, never what they wrote, and never names them.
- **Shape.** The length of a mail (about 250, 500 or 900 words), its structure, and
  how finished the draft is, from an outline to a third round.
- **Learn from my own writing.** Tick it and the Ghostwriter reads your last two sent
  broadcasts so the draft sounds like you.

**One mail.** In the composer, for a broadcast or a sequence step, give it a topic and
your notes. The draft lands in the editor as one change you can undo. Nothing is saved
or sent. Facts come only from your notes. Where it needs something it does not know,
it leaves a `[[ placeholder ]]`, and a sequence cannot go live with one.

**A whole sequence, as takes.** On a sequence, open **Ghostwriter takes**, say what
the sequence is about and what it should do, and add your notes. It writes every mail
of the sequence as a numbered take that sits beside the real one. It writes in the
background, a few mails a minute, and the page refreshes itself. Nothing in the
sequence changes until you click **Use this mail** on one mail, and only while the
sequence is paused. A used mail starts with an `[[ AI draft ]]` line, which blocks
going live until you have read that step and deleted the line. Your own words are
kept, and you can put them back.

### 👥 Reader council

Before a draft goes out, click **Ask the council** beside a broadcast or a sequence
step. Three readers and an editor read it: a fan, a skeptic, and a reader in the
middle who leaves when bored. The review opens on its own page, with the draft on one
side and their notes beside the passages they are about. The editor says what to keep
and what to cut.

The three readers are modelled on your audience by four dials you set on the review
page: who they are, how much they know, why they read, and how they read.

The council is advisory. It sends nothing, blocks nothing, and never changes a draft.

### 🚀 Launch Studio

**Money → Launch Studio** takes one offer through seven steps: describe the offer,
plan the launch, open a campaign, build the sequence, write the copy, take it live,
and review the launch.

It works with AI off. The sequence step copies a launch template into a paused
sequence on the launch's campaign. With AI on, two buttons appear: one drafts the
sequence's mails from your brief, and one suggests an outline of the sales angle,
which fills a box for you to edit and saves nothing until you save it.

The studio sends nothing, enrolls nobody and activates nothing. The sequence cannot go
live until every `[[ placeholder ]]` is rewritten, and going live is the sequence
screen's own **Go live**.

### 🔒 What is sent to a model, and what is not

Only your own words go out, and only when you click a helper.

| Helper | What the model is given |
|---|---|
| **Suggest a subject** | The draft, and your recent sent subject lines |
| **Clean this up** | The draft |
| **Draft it for me** | The template, your brief, and your last two sent broadcasts |
| **Ghostwriter** | The topic and your notes, the voice settings, and your last two sent broadcasts if you ticked the box. A take is also given the sequence's name, its description and its existing mails |
| **Reader council** | The draft, and the four dials turned into sentences |
| **Launch angle** | The launch brief |

No subscriber data is sent to a model: not an address, a name, a count or a tag. The
council's readers are built from the four dials alone. The only mail a helper reads is
mail you already sent to the whole list.

What comes back is treated as untrusted text. The Ghostwriter's output is stripped of
markup and images, and a link to anywhere you did not name becomes `[[ link ]]`.

### 🧪 Trying it locally with no key

Add `AI_PROVIDER=fake` to `.dev.vars` and every helper answers from a fake model on
your machine: canned text, no key, no network. The AI screen says when it is on. It is
for local work only. Never set it in production.

---

[Back to the README](../README.md)
