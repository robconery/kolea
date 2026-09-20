# 🧹 slop

Finds the sentences that read as machine-written, and says **which ones**.

An AI detector gives you a number, and you can't edit a number. This gives you
character ranges, a name for each one, and a sentence on what to do instead, so
an editor can underline the words and a writer can fix them.

Pure TypeScript. No dependencies, no DOM, no network, no model. Runs in a
browser, a Worker, Node, Bun or Deno. A newsletter takes a couple of
milliseconds, so it is fast enough to run as you type.

## 🚀 Use

```ts
import { findSlop } from './slop'

const report = findSlop("Here's the thing: it's not a bug, it's a feature.")

report.score // 0–100
report.band  // 'clean' | 'some' | 'heavy'
report.hits  // [{ rule: 'heres-the-thing', start: 0, end: 16, label, why, … }]
report.notes // document-level tells that point at nothing
```

Pass a string (plain text or light markdown), or pass blocks when you know the
document's structure. Blocks are what let an editor map a hit to an exact node:

```ts
findSlop([
  { kind: 'heading', text: 'Key Takeaways' },
  { kind: 'listItem', text: 'Speed: it is fast', leadBold: 6 },
  { kind: 'paragraph', text: 'Let that sink in.' },
])
```

`hit.start` and `hit.end` index into `blocks[hit.block].text`. For string input,
`fromText(text)` returns the blocks with an `offset` each, so
`offset + hit.start` is a position in the string you started with.

Quoted text and code are skipped. Somebody else's words are not the writer's.

## 🎛 Options

```ts
findSlop(text, {
  disable: ['em-dash', 'vocabulary'], // rule ids or whole categories
  extra: [myRule],                    // your own house rules
})
```

## 📏 What it looks for

| Category | Examples |
|---|---|
| `punctuation` | em-dashes, spaced en-dashes, `--` |
| `lead-in` | "Here's the thing", "Let me be clear", "Plot twist:", "Enter Redis.", "Let's dive in" |
| `frame` | "It's not X, it's Y", "not just X but Y", "The best part?", "The result: chaos.", "Whether you're a…" |
| `mic-drop` | "Let that sink in", "Full stop.", "And that changes everything" |
| `filler` | "It's worth noting", adverb openers, "In today's fast-paced world", summary endings |
| `vocabulary` | delve, tapestry, leverage, seamless, robust (three weight tiers) |
| `flourish` | "does the heavy lifting", "north star", "where the magic happens" |
| `structure` | "Key Takeaways" headings, bold-label bullets, emoji bullets, one-word punchline paragraphs |
| `rhythm` | "No fluff. No filler. Just results.", "faster, cleaner, smarter", every sentence the same length |

Rules are data, in `rules.ts`. Each has a weight: **3** nobody writes by
accident, **2** a strong tell, **1** innocent alone and only counts in numbers.

## 🧮 The score

A density, not a count. Weighted tells per 100 words (`d`) go through
`100 × d / (d + 4)`. Three tells in 2,000 words is a clean piece. Three in sixty
is not. The curve never pegs at 100, so in a draft that is wall-to-wall slop
every fix still moves the number. Drafts under 120 words are measured against
120, so one em-dash in a two-line note doesn't swing the dial.

## ⚠️ What it can't do

Regex finds *worn* phrases. It cannot find an *invented* flourish: a fresh
metaphor standing where a plain statement should be has no fixed shape, and
spotting it takes a reader. It also reads English only.

It is not a detector, and a clean score does not mean a person wrote it. It
means the text has none of the habits that make readers stop reading.

## 🧪 Tests

```bash
bun test src/slop
```

The "leaves people alone" block is the one to grow. Every false positive found
in real writing goes in there as a sentence that must stay unflagged.

## 🙏 Credit

Some vocabulary and the opener, closer and filler patterns are adapted from
[SlopTotal](https://github.com/pablocaeg/sloptotal) (MIT), whose linguistic
engines score a whole text. The structural and rhythm rules, the positions, and
the scoring are this module's own.
