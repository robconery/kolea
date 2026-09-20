import { describe, expect, test } from 'bun:test'
import { type Block, findSlop, fromText } from './index.ts'

const rules = (text: string | Block[]) => findSlop(text).hits.map((h) => h.rule)

describe('points at the words', () => {
  test('a hit is a range in the text it was given', () => {
    const text = "I shipped it on Friday. Here's the thing: nobody noticed."
    const [hit] = findSlop(text).hits
    expect(hit?.rule).toBe('heres-the-thing')
    expect(text.slice(hit!.start, hit!.end)).toBe("Here's the thing")
  })

  test('curly quotes match and keep their offsets', () => {
    const text = 'Here’s the thing about Postgres.'
    const [hit] = findSlop(text).hits
    expect(hit?.text).toBe('Here’s the thing')
  })

  test('fromText offsets map back into the original string', () => {
    const text = '# Title\n\n- **Speed:** it delves deep\n'
    const blocks = fromText(text)
    const hit = findSlop(blocks).hits.find((h) => h.rule === 'vocab-strong')!
    const at = blocks[hit.block]!.offset! + hit.start
    expect(text.slice(at, at + hit.text.length)).toBe('delves')
  })

  test('overlapping rules report once, by the heavier rule', () => {
    const hits = findSlop('We work in the realm of databases.').hits
    expect(hits).toHaveLength(1)
  })
})

describe('the tells', () => {
  const cases: [string, string][] = [
    ['em-dash', 'It was fast — really fast.'],
    ['em-dash', 'It was fast -- really fast.'],
    ['heres-the-thing', "But here's what nobody tells you about indexes."],
    ['nobody-tells-you', "This is what most people don't realize about Redis."],
    ['let-me', 'Let me be clear. It broke.'],
    ['let-me', 'It broke. Honestly, I was surprised.'],
    ['label-colon', 'Plot twist: it was DNS.'],
    ['scene-cut', 'Fast forward to last week.'],
    ['enter-x', 'I needed a queue. Enter Redis.'],
    ['signpost', "Let's dive in."],
    ['not-x-its-y', "It's not about the tools, it's about the mindset."],
    ['not-x-its-y', "This isn't a bug. It's a feature."],
    ['not-x-its-y', "You're not buying a course. You're buying your time back."],
    ['not-just-but', 'It is not just a database but a platform.'],
    ['question-hook', 'It shipped. The best part? Nobody noticed.'],
    ['colon-reveal', 'I ran it twice. The result: chaos.'],
    ['whether-youre', "Whether you're a seasoned engineer or just starting out, read on."],
    ['mic-drop', 'It cost nothing. Let that sink in.'],
    ['full-stop', 'ORMs are a mistake. Full stop.'],
    ['worth-noting', "It's worth noting that this is slow."],
    ['adverb-opener', 'Essentially, it worked.'],
    ['grand-opening', "In today's fast-paced digital world, speed matters."],
    ['ai-closer', 'Only time will tell.'],
    ['vocab-strong', 'A rich tapestry of services.'],
    ['vocab-business', 'We leverage Postgres.'],
    ['vocab-soft', 'A robust solution.'],
    ['flourish', 'Postgres does the heavy lifting.'],
    ['staccato', 'No fluff. No filler. Just results.'],
    ['staccato', 'I changed one line. Small change. Big difference.'],
    ['triplet', 'It is faster, cleaner, and smarter.'],
  ]
  for (const [rule, text] of cases) {
    test(`${rule}: ${text}`, () => expect(rules(text)).toContain(rule))
  }

  test('summary heading', () => {
    expect(rules([{ text: 'Key Takeaways', kind: 'heading' }])).toContain('summary-heading')
  })

  test('bold-label bullets need three to be a template', () => {
    const item = (t: string): Block => ({ text: t, kind: 'listItem', leadBold: t.indexOf(':') + 1 })
    expect(rules([item('Speed: fast'), item('Cost: low')])).not.toContain('bold-lead-bullets')
    expect(rules([item('Speed: fast'), item('Cost: low'), item('Scale: big')])).toContain('bold-lead-bullets')
  })

  test('punchline and question paragraphs, but not the sign-off', () => {
    const p = (text: string): Block => ({ text })
    const doc = [p('I rewrote the whole thing over a weekend.'), p('Exactly.'), p('The catch is cost?'), p('More next week, I promise you that.'), p('Thanks!'), p('Rob')]
    const found = rules(doc)
    expect(found).toContain('one-liner')
    expect(findSlop(doc).hits.some((h) => h.text === 'Thanks!')).toBe(false)
  })
})

describe('leaves people alone', () => {
  const clean = [
    "If I'm honest, I didn't expect it to work.",
    'I used Postgres, Redis and Node for this one.',
    "That's it for this week. See you Friday.",
    'Thanks for reading. Talk soon.',
    'Navigate to the settings page and click Save.',
    'What are you building this week?',
    'I spent the weekend on it - mostly fighting DNS.',
    'The Node ecosystem moves quickly, which is a problem when you have a day job.',
    // From real sent newsletters.
    'AI is leverage. Let it take you to places you did not even consider.',
    'Eggs are not easy to make, whether boiled, scrambled, or fried.',
    'Testing, refactoring, adjusting, and optimizing have become so simple.',
    'That is truly the hard part of software development!',
    'We could get lost in this question, because honestly: how would you know this anyway?',
    'To be clear I understand the point being made.',
    'When it comes down to it: I have a simple need.',
    'We are working with a gigantic codebase, which changes everything.',
  ]
  for (const text of clean) test(text, () => expect(findSlop(text).hits).toEqual([]))

  test('quotes and code are not the writer', () => {
    expect(findSlop('> Here\'s the thing — delve.\n\n```\nlet x = "leverage"\n```\n').hits).toEqual([])
  })

  test('rules and categories can be switched off', () => {
    const text = 'Fast — and we leverage it.'
    expect(findSlop(text, { disable: ['em-dash'] }).hits.map((h) => h.rule)).toEqual(['vocab-business'])
    expect(findSlop(text, { disable: ['punctuation', 'vocabulary'] }).hits).toEqual([])
  })
})

describe('the score', () => {
  test('is a density: the same tell weighs less in a longer piece', () => {
    const tell = "Here's the thing."
    const filler = ' I wrote some code and then I tested it on my laptop before lunch.'.repeat(40)
    expect(findSlop(tell).score).toBeGreaterThan(findSlop(tell + filler).score)
  })

  test('an unedited chatbot draft is heavy; plain prose is clean', () => {
    const slop =
      "In today's fast-paced digital landscape, email matters more than ever. Here's the thing — it's not about sending more, it's about sending better. Let's dive in. The best part? It's seamless. We leverage robust tooling to unlock your potential — faster, cleaner, smarter. No fluff. No filler. Just results. Let that sink in. Ultimately, the possibilities are endless."
    const plain =
      'I broke production on Tuesday. I had changed the index on the orders table without checking what the nightly job did with it, and the job ran for six hours instead of four minutes. I found it because the disk alarm went off. The fix was one line, which is always how it goes, and I have added a check to the deploy script so I cannot do it again.'
    expect(findSlop(slop).band).toBe('heavy')
    expect(findSlop(plain).band).toBe('clean')
    expect(findSlop(plain).hits).toEqual([])
  })
})
