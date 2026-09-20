import type { Sentence } from './text.ts'

/**
 * The catalogue. Every rule is a small, named opinion about one way prose goes
 * wrong when a model writes it and nobody rewrites it.
 *
 * A rule earns its place by being **pointable**: it must be able to say *these
 * characters, for this reason*. Signals that can only be stated about a whole
 * document ("the sentences are all the same length") live at the bottom as
 * notes — they move the score, and they underline nothing.
 *
 * Weights, and what they mean:
 *
 *   3  Nobody writes this by accident. One is enough to lose a reader.
 *   2  A strong tell. A person might write it once; a model writes it by habit.
 *   1  Innocent alone, and legitimately used ("robust", a tidy triplet). Only
 *      counts for something when it arrives in numbers.
 *
 * Some of the vocabulary and the opener/closer/filler patterns are adapted from
 * SlopTotal (https://github.com/pablocaeg/sloptotal, MIT) — see README.md.
 */

export type Category =
  | 'punctuation'
  | 'lead-in'
  | 'frame'
  | 'mic-drop'
  | 'filler'
  | 'vocabulary'
  | 'flourish'
  | 'structure'
  | 'rhythm'

export type BlockKind = 'paragraph' | 'heading' | 'listItem'

/** A block as the rules see it: folded text, plus what the finder worked out about it. */
export interface RuleBlock {
  text: string
  kind: BlockKind
  /** Length of the bold run the block opens with, 0 if it doesn't. */
  leadBold: number
  words: number
  sentences: Sentence[]
}

export interface RuleDoc {
  blocks: RuleBlock[]
  /** Indexes of the non-heading blocks, in order — "the first paragraph" means `prose[0]`. */
  prose: number[]
}

export interface Span {
  block: number
  start: number
  end: number
}

interface RuleBase {
  id: string
  category: Category
  /** What it is, in three or four words. */
  label: string
  /** What to do about it, said to the writer. */
  why: string
  weight: 1 | 2 | 3
}

export interface PatternRule extends RuleBase {
  pattern: RegExp
  /** Only look in these kinds of block. Default: paragraphs and list items. */
  kinds?: BlockKind[]
  /** Only look in the first or last two prose blocks. */
  zone?: 'opening' | 'closing'
}

export interface CustomRule extends RuleBase {
  find(doc: RuleDoc): Span[]
}

export type Rule = PatternRule | CustomRule

/** A document-level signal: it moves the score and points at nothing. */
export interface NoteRule extends RuleBase {
  test(doc: RuleDoc): boolean
}

/* ─────────────────────────────────────────────────────────────── builders */

/**
 * Start of a sentence: start of the block, or after terminal punctuation and
 * space. A lookbehind, so the match — and therefore the underline — is the
 * phrase alone and never the full stop before it.
 */
const SENTENCE_START = `(?<=^\\s*["'(]?|[.!?\\u2026:]["')]?\\s+["'(]?)`

/** Matches only where a sentence begins. "Honestly," is a tell; "if I'm honest" is a person. */
const opens = (src: string) => new RegExp(`${SENTENCE_START}(?:${src})`, 'gi')

/** Matches anywhere, on word boundaries. */
const has = (src: string) => new RegExp(`\\b(?:${src})\\b`, 'gi')

/** A word list. Entries are regex source, so `delv(?:e|es|ed|ing)` is fine. */
const words = (...list: string[]) => has(list.join('|'))

/* ────────────────────────────────────────────────────────────── the rules */

export const RULES: Rule[] = [
  /* punctuation */
  {
    id: 'em-dash',
    category: 'punctuation',
    label: 'Em-dash',
    why: 'The single loudest AI tell there is. Use a comma, parentheses, or start a new sentence.',
    weight: 2,
    kinds: ['paragraph', 'listItem', 'heading'],
    // The dash itself, a spaced en-dash doing an em-dash's job, or a typed `--`.
    pattern: /\s?—\s?|\s–\s|(?<=\w)\s?--\s?(?=\w)/g,
  },

  /* lead-ins: throat-clearing before the sentence that should have come first */
  {
    id: 'heres-the-thing',
    category: 'lead-in',
    label: '"Here\'s the thing"',
    why: 'An announcement that a sentence is coming. Delete it and say the sentence.',
    weight: 3,
    pattern: opens(
      "(?:and |but |so |now,? |because )?here(?:'s| is) (?:the (?:thing|deal|kicker|catch|truth|reality|problem|secret|part|bit|twist|rub|good news|bad news)\\b|what (?:nobody|no one|most people|they|i've learned|that means|matters|happened|i mean)\\b|why(?: that| this| it)? matters\\b|where it gets\\b)",
    ),
  },
  {
    id: 'nobody-tells-you',
    category: 'lead-in',
    label: 'The secret nobody tells you',
    why: 'It flatters you and talks down to everyone else. Say the thing; skip the reveal.',
    weight: 3,
    pattern: has(
      "what (?:most people|nobody|no one|everyone|they) (?:miss(?:es)?|tells? you|talks? about|realizes?|understands?|gets? wrong|(?:don't|doesn't|won't) (?:tell you|realize|understand|get|know|talk about))|the (?:real |dirty little |little |open )?secret (?:is|to|nobody|no one)|(?:nobody|no one) (?:is talking|talks|tells you|told (?:me|you)) about",
    ),
  },
  {
    id: 'let-me',
    category: 'lead-in',
    label: 'Announcing honesty',
    why: 'If you have to announce you are being honest or clear, the last paragraph wasn\'t. Cut the announcement.',
    weight: 2,
    pattern: opens(
      "let me (?:explain|be clear|be honest|be real|be blunt|break (?:it|this|that) down|tell you|paint)|let's be (?:honest|real|clear)|let's face it|honestly,|to be (?:honest|fair|clear),|i'll be honest|i'm not going to lie|not gonna lie|real talk|truth is,|the truth is|the reality is|the fact is|the thing is,|look,|listen,|make no mistake",
    ),
  },
  {
    id: 'label-colon',
    category: 'lead-in',
    label: 'Stage label',
    why: 'A label borrowed from social posts. Nobody says "plot twist" out loud to a friend.',
    weight: 2,
    pattern: opens(
      '(?:spoiler(?: alert)?|plot twist|hot take|unpopular opinion|pro tip|fun fact|quick tip|reminder|psa|tl;?dr|bottom line|translation|the upshot|the takeaway)\\s?:',
    ),
  },
  {
    id: 'scene-cut',
    category: 'lead-in',
    label: 'Movie-trailer transition',
    why: 'A screenplay cue standing in for a transition. Say what happened next.',
    weight: 2,
    pattern: opens(
      "fast[- ]forward (?:to|a few|\\d)|cut to\\b|buckle up|strap in|stick around|picture this|imagine this|imagine a world|think about it|consider this|and then it hit me|that's when it (?:hit|clicked)",
    ),
  },
  {
    id: 'enter-x',
    category: 'lead-in',
    label: '"Enter X."',
    why: 'A drum roll for a tool. Introduce it in a sentence that says what it does.',
    weight: 2,
    // Case-sensitive on purpose: "Enter" then a proper noun, as a whole sentence.
    pattern: /(?<=^\s*|[.!?]\s+)Enter:? (?:[A-Z][\w.+#-]*)(?: [A-Z][\w.+#-]*){0,2}\.(?=\s|$)/g,
  },
  {
    id: 'signpost',
    category: 'lead-in',
    label: 'Signposting',
    why: 'Narrating the structure of the piece instead of getting on with it.',
    weight: 2,
    pattern: has(
      "let's (?:dive|dig|jump|get|delve)(?: right| straight| deep)? in(?:to)?|let's (?:unpack|break (?:it|this|that|things) down|explore|take a (?:closer |quick |deeper )?look|walk through|get started|zoom (?:in|out))|without further ado|in this (?:email|post|article|issue|newsletter|guide),? (?:i'll|we'll|i will|we will|you'll|you will|i want to)|by the end of this (?:email|post|article|guide)|(?:more on that|we'll get to that) (?:in a (?:moment|minute|bit|sec)|later|below|shortly)",
    ),
  },

  /* frames: sentence shapes a model reaches for because they sound like insight */
  {
    id: 'not-x-its-y',
    category: 'frame',
    label: '"It\'s not X, it\'s Y"',
    why: 'Knocking down a claim nobody made, to make the real one sound deeper. Say Y once.',
    weight: 3,
    pattern: new RegExp(
      [
        // It's not about the tools, it's about the mindset.
        "\\b(?:it|this|that)(?:'s| is| was) not (?:about |just |only |merely |really |simply )*[^.?!\\n]{2,70}?(?:[,;]| \\u2014| -)\\s*(?:it|this|that)(?:'s| is| was)\\b",
        // This isn't a bug. It's a feature.
        "\\b(?:isn't|wasn't|aren't|weren't|is not|was not|are not)(?: about| just| only| merely| really| simply)* [^.?!\\n]{2,70}[.?!]\\s+(?:it|this|that|they)(?:'s|'re| is| was| are)\\b",
        // You're not buying a course. You're buying...
        "\\b(?:you're|you are|we're|we are|they're|they are|i'm|i am) not (?:just |only |merely |really |simply )?[^.?!\\n]{2,70}[.,;]\\s+(?:you're|you are|we're|we are|they're|they are|i'm|i am)\\b",
        '\\bnot because [^.?!\\n]{2,90}?,? but because\\b',
      ].join('|'),
      'gi',
    ),
  },
  {
    id: 'not-just-but',
    category: 'frame',
    label: '"Not just X, but Y"',
    why: 'A scale built to make Y look bigger. If Y matters, it can stand on its own.',
    weight: 2,
    pattern: has(
      'not (?:just|only|merely|simply) [^.?!\\n]{2,70}?,? but(?: also)?|(?:so )?much more than(?: just)?|more than just (?:a|an|the)',
    ),
  },
  {
    id: 'question-hook',
    category: 'frame',
    label: 'Self-answered question',
    why: 'Asking yourself a question so you can answer it. Drop the question; keep the answer.',
    weight: 3,
    pattern: new RegExp(
      `${SENTENCE_START}(?:(?:and |but |so )?the (?:\\w+ ){0,2}(?:part|catch|result|kicker|twist|problem|answer|reason|truth|secret|upside|downside|difference|solution|lesson|irony|fix|trick|payoff|takeaway|bottom line)\\?|sound familiar\\?|why\\?|how\\?|the result\\?|so what\\?|(?:but )?why does (?:this|that|it) matter\\?|want to know (?:what|how|why|the)[^.?!\\n]{0,50}\\?|(?:you )?know what(?:'s| is) (?:wild|crazy|funny|interesting|worse|better)\\?|guess what\\?|(?:and )?(?:you )?know what\\?|what(?:'s| is) the (?:catch|point|alternative|solution|answer|fix)\\?)`,
      'gi',
    ),
  },
  {
    id: 'colon-reveal',
    category: 'frame',
    label: 'Colon reveal',
    why: 'A drum roll, then a colon. Write it as a plain sentence: "It broke reactivity."',
    weight: 2,
    pattern: opens(
      '(?:and |but |so )?the (?:\\w+ )?(?:result|answer|truth|catch|problem|takeaway|lesson|point|reality|bottom line|solution|reason|kicker|difference|fix|trick|upshot|verdict|good news|bad news)(?: is| was)?:',
    ),
  },
  {
    id: 'whether-youre',
    category: 'frame',
    label: '"Whether you\'re a…"',
    why: 'Addressing everybody at once, which reads as addressing nobody. Write to one reader.',
    weight: 2,
    pattern: has(
      "whether you(?:'re| are) (?:a |an |just |new |looking |building |trying )|if you(?:'re| are) (?:like most|anything like me|like me)|you've (?:probably|likely|no doubt) (?:felt|seen|heard|noticed|been|experienced|wondered|asked)|we've all (?:been there|done it|seen|felt|had)|if you've ever (?:wondered|felt|struggled|tried|found yourself)",
    ),
  },

  /* mic drops: the line written to be screenshotted */
  {
    id: 'mic-drop',
    category: 'mic-drop',
    label: 'Mic drop',
    why: 'A line telling the reader how to feel about the last line. Trust the last line.',
    weight: 3,
    pattern: has(
      "let that sink in|read that (?:again|twice|back)|(?:and )?that(?:'s| is) (?:the (?:whole |entire |real )?(?:point|problem|secret|game|job|difference|magic|beauty of it|trick)|the part that matters|what matters|when everything changed)|(?:and )?that changes everything|(?:and )?it changes everything|this changes everything|game over|end of story|it's that simple|simple as that|nothing more,? nothing less|no more,? no less|the rest is history|and (?:honestly|frankly)\\?",
    ),
  },
  {
    id: 'full-stop',
    category: 'mic-drop',
    label: '"Full stop."',
    why: 'Punctuation read aloud for emphasis. The sentence before it already ended.',
    weight: 3,
    pattern: /(?<=[.!?]["')]?\s+)(?:Full stop|Period|End of story|Mic drop)\.(?=\s|$)/g,
  },

  /* filler: words that take up the room a thought should have had */
  {
    id: 'worth-noting',
    category: 'filler',
    label: 'Hedge',
    why: 'If it is worth noting, note it. The preamble adds six words and no information.',
    weight: 2,
    pattern: has(
      "it(?:'s| is) (?:also )?(?:important|worth|crucial|essential|critical|interesting|helpful|useful) (?:to )?(?:not(?:e|ing)|remember(?:ing)?|mention(?:ing)?|highlight(?:ing)?|consider(?:ing)?|understand(?:ing)?|recogniz(?:e|ing)|point(?:ing)? out|keep(?:ing)? in mind|emphasiz(?:e|ing)|acknowledg(?:e|ing))|it (?:should|must|bears?) (?:be )?(?:noted|noting|mention(?:ed|ing)|repeating)|needless to say|it goes without saying|first and foremost|last but not least|(?:that|with that|having|all that) (?:being )?said,|at its core|in essence|simply put|put simply|in other words|by and large|for all intents and purposes|when all is said and done|in many ways|in a (?:very real )?sense|to put it (?:simply|another way|bluntly)|as (?:you|we) (?:may|might|probably|all) know|when it comes to|in the realm of|now more than ever|in today's (?:\\w+[- ]){0,3}(?:world|age|era|landscape)",
    ),
  },
  {
    id: 'adverb-opener',
    category: 'filler',
    label: 'Adverb opener',
    why: 'A throat-clear. The sentence is almost always stronger starting at the next word.',
    weight: 1,
    pattern: opens(
      '(?:ultimately|essentially|fundamentally|importantly|interestingly|notably|crucially|remarkably|undoubtedly|arguably|admittedly|naturally|clearly|simply|basically|frankly|indeed|moreover|furthermore|additionally|consequently|overall|in fact|of course),',
    ),
  },
  {
    id: 'grand-opening',
    category: 'filler',
    label: 'Grand opening',
    why: 'Opening from orbit. Start with the specific thing that happened to you this week.',
    weight: 3,
    zone: 'opening',
    pattern: has(
      "in today's (?:\\w+[- ]){0,3}(?:world|age|era|landscape|society|economy|market|environment|climate)|in (?:a|the|an) (?:world|era|age|landscape|time) (?:where|of|when|that)|in the (?:ever[- ]\\w+|fast[- ]paced|rapidly \\w+) (?:world|landscape|field) of|as (?:technology|the world|society|ai|the industry) continues to|(?:it's no (?:secret|surprise)|there's no denying|it's undeniable) that|in recent years|the (?:rise|emergence|advent|proliferation|dawn) of|i hope this (?:email|message|note|letter) finds you",
    ),
  },
  {
    id: 'closer',
    category: 'filler',
    label: 'Summary ending',
    why: 'Restating the piece to the person who just read it. End on the last real thing you had to say.',
    weight: 2,
    zone: 'closing',
    pattern: opens(
      "(?:so,? )?(?:in conclusion|in summary|in short|in the end|to sum(?: it| things)? up|to summarize|to recap|to wrap(?: things| it)? up|all in all|ultimately|at the end of the day|the bottom line(?: is)?|the takeaway(?: is)?|long story short|so,? the next time|moving forward|going forward|as we (?:navigate|move forward|look ahead|continue)|remember[:,]|so remember)",
    ),
  },
  {
    id: 'ai-closer',
    category: 'filler',
    label: 'Horizon gazing',
    why: 'Gesturing at the future because the piece ran out of things to say.',
    weight: 2,
    pattern: has(
      'only time will tell|the possibilities are (?:endless|limitless)|the future (?:is|looks|holds|of \\w+ is) (?:bright|here|now|exciting|promising)|(?:one|this much) (?:thing )?is (?:clear|certain)|(?:by|through) (?:embracing|leveraging|harnessing|adopting) |the sky(?:\'s| is) the limit|the journey (?:is just beginning|has only just begun|continues)|the best is yet to come|what are you waiting for|the choice is yours|(?:your|the) (?:next|first) (?:step|chapter) (?:is|starts|begins)',
    ),
  },

  /* vocabulary */
  {
    id: 'vocab-strong',
    category: 'vocabulary',
    label: 'Model vocabulary',
    why: 'A word models use constantly and people almost never say out loud. Use the plain one.',
    weight: 3,
    kinds: ['paragraph', 'listItem', 'heading'],
    pattern: words(
      'delv(?:e|es|ed|ing)',
      'tapestr(?:y|ies)',
      'multifaceted',
      'ever[- ](?:evolving|changing|growing|shifting|expanding)',
      'thought[- ]provoking',
      '(?:a|is a|stands as a|serves as a) testament(?: to)?',
      'supercharg(?:e|es|ed|ing)',
      'synerg(?:y|ies|istic)',
      'paradigm(?: shift)?',
      'plethora',
      'a myriad of|myriad',
      '(?:the|a) realm(?: of)?',
      'cornerstone',
      'game[- ]chang(?:er|ers|ing)',
      'revolutioniz(?:e|es|ed|ing)',
      'embark(?:s|ed|ing)?(?: on)?',
      'beacon',
      'bustling',
      'intricac(?:y|ies)',
      'meticulous(?:ly)?',
      'commendable',
      'showcas(?:e|es|ed|ing)',
      'underscor(?:e|es|ed|ing)',
      'unleash(?:es|ed|ing)?',
      'unparalleled',
      'indispensable',
      'treasure trove',
      'unwavering',
      'labyrinth(?:ine)?',
      'nestled',
      'whimsical',
      'mind[- ]blow(?:n|ing)',
      "chef's kiss",
    ),
  },
  {
    id: 'vocab-business',
    category: 'vocabulary',
    label: 'Brochure verb',
    why: 'Brochure language. "Use", "help", "build", "fix": the short verb is the one a person says.',
    weight: 2,
    kinds: ['paragraph', 'listItem', 'heading'],
    pattern: words(
      // The verb. "AI is leverage" is a noun, and a fair one.
      'leverag(?:es|ed|ing)|(?:to|can|could|will|would|should|we|you|i|they|and|or|then|just|simply|also) leverage',
      'utiliz(?:e|es|ed|ing|ation)',
      'harness(?:es|ed|ing)?',
      'foster(?:s|ed|ing)?',
      'empower(?:s|ed|ing|ment)?',
      'elevat(?:e|es|ed|ing)',
      'unlock(?:s|ed|ing)? (?:the|your|its|their|new|true|full|hidden)',
      'seamless(?:ly)?',
      'holistic(?:ally)?',
      'pivotal',
      'transformative',
      'groundbreaking',
      'cutting[- ]edge',
      'state[- ]of[- ]the[- ]art',
      'best[- ]in[- ]class',
      'world[- ]class',
      'next[- ]level',
      'spearhead(?:s|ed|ing)?',
      'facilitat(?:e|es|ed|ing)',
      'invaluable',
      'vibrant',
      'resonat(?:e|es|ed|ing)',
      'curat(?:e|ed|ing) (?:a |an |the |your )?(?:list|selection|collection|experience)',
      'navigat(?:e|es|ed|ing) (?:the|this|these|today\'s|a) (?:complex\\w*|world|landscape|challenges?|waters|uncertaint\\w+|nuances)',
      'plays? an? (?:crucial|key|vital|pivotal|critical|important|significant) role',
      'rich (?:history|tapestry|heritage|ecosystem)',
    ),
  },
  {
    id: 'vocab-soft',
    category: 'vocabulary',
    label: 'Inflated word',
    why: 'Fine once. In numbers it is the sound of a model filling space. Try the plainer word.',
    weight: 1,
    pattern: words(
      'crucial(?:ly)?',
      'robust',
      'nuanced?',
      'comprehensive',
      'streamlin(?:e|es|ed|ing)',
      'enhanc(?:e|es|ed|ing)',
      'innovative',
      'landscape',
      '(?:your|my|our|the|this|a) journey',
      'intricate',
      'profound(?:ly)?',
      'remarkabl[ey]',
      'ensur(?:e|es|ing) that',
      'a (?:wide|broad|diverse) (?:range|array|variety) of',
      'actionable',
    ),
  },

  /* flourish: the clichés of mannered prose. The invented ones need a reader;
     the worn ones can be listed. */
  {
    id: 'flourish',
    category: 'flourish',
    label: 'Stock flourish',
    why: 'A borrowed image doing the work of a plain statement. Say the literal thing it stands for.',
    weight: 2,
    kinds: ['paragraph', 'listItem', 'heading'],
    pattern: has(
      "earns? (?:its|their|your) keep|(?:goes?|went|go) to die|(?:does|do|doing|did) the heavy lifting|heavy lifting|the wheels (?:come|came|fall|fell) off|double[- ]edged sword|elephant in the room|mov(?:e|es|ed|ing) the needle|table stakes|north star|secret sauce|low[- ]hanging fruit|at the end of the day|tip of the iceberg|perfect storm|silver bullet|deep dive|unsung hero|love letter to|a masterclass in|speaks? volumes|where the (?:real )?magic happens|the real magic|breath of fresh air|hill (?:i'll|i will|to|i'd|worth) d(?:ie|ying) on|double(?:d|s)? down|lean(?:s|ed|ing)? in(?:to)?|level(?:s|ed|ing)? up|on steroids|stands? the test of time|a whole new (?:level|world|ballgame)|(?:hit|hits|hitting) different|sweet spot|the holy grail|(?:peel|peeling) back the (?:layers|curtain)|(?:scratch(?:es|ed|ing)?) the surface|paint(?:s|ed)? a picture|(?:quietly|silently) (?:revolution|transform|reshap|chang|rewrit|eating|becom|tak)\\w*|(?:rewrit|chang|redefin)(?:e|es|ing) the (?:rules|game)|in the trenches|the (?:missing|final) piece of the puzzle|(?:a|the) symphony of|dance between|(?:threads?|weav(?:e|es|ing)) (?:together|through)",
    ),
  },

  /* structure: read from the shape of the document, not its words */
  {
    id: 'summary-heading',
    category: 'structure',
    label: 'Heading that describes',
    why: 'A heading that names the section\'s job instead of its subject. Say what the section says.',
    weight: 2,
    kinds: ['heading'],
    pattern:
      /^\W*(?:key takeaways?|(?:the )?takeaways?|why (?:this|it|that) matters|what (?:this|it) means(?: for you)?|the bottom line|final thoughts|closing thoughts|conclusion|in summary|summary|wrapping (?:it )?up|tl;?dr|the big picture|moving forward|looking ahead|what's next|next steps|introduction|overview|the problem|the solution|why it works|how it works|the results?|lessons learned)\W*$/gi,
  },
  {
    id: 'bold-lead-bullets',
    category: 'structure',
    label: 'Bold-label bullets',
    why: 'Every bullet opening with a bold label and a colon is the default shape of a chatbot answer. Write the point as a sentence.',
    weight: 2,
    find(doc) {
      const spans: Span[] = []
      doc.blocks.forEach((b, i) => {
        if (b.kind !== 'listItem' || b.leadBold < 2) return
        const label = b.text.slice(0, b.leadBold).trimEnd()
        const after = b.text.slice(b.leadBold).trimStart()
        if (/[:.–—-]$/.test(label) || /^[:–—-]/.test(after)) {
          spans.push({ block: i, start: 0, end: b.leadBold })
        }
      })
      // One labelled bullet is a definition list. Three is a template.
      return spans.length >= 3 ? spans : []
    },
  },
  {
    id: 'emoji-bullet',
    category: 'structure',
    label: 'Emoji bullet',
    why: 'An emoji in place of a bullet or in front of a heading is slide-deck decoration, not writing.',
    weight: 1,
    kinds: ['listItem', 'heading'],
    pattern: /^\s*\p{Extended_Pictographic}️?/gu,
  },
  {
    id: 'one-liner',
    category: 'structure',
    label: 'Punchline paragraph',
    why: 'A paragraph of one or two words, set apart for effect. If the paragraph before it landed, this is an echo.',
    weight: 2,
    find(doc) {
      const spans: Span[] = []
      // The sign-off is allowed to be short.
      const body = doc.prose.slice(0, -2)
      for (const i of body) {
        const b = doc.blocks[i]
        if (!b || b.kind !== 'paragraph' || b.words === 0 || b.words > 2) continue
        const t = b.text.trim()
        if (!/[.!]$/.test(t) || SIGN_OFF.test(t)) continue
        spans.push({ block: i, start: b.text.indexOf(t), end: b.text.indexOf(t) + t.length })
      }
      return spans
    },
  },
  {
    id: 'question-paragraph',
    category: 'structure',
    label: 'Question as transition',
    why: 'A one-line question set on its own to pull the reader along. Make the turn in a sentence instead.',
    weight: 2,
    find(doc) {
      const spans: Span[] = []
      // A closing question to the reader ("What are you building?") is a real one.
      const body = doc.prose.slice(0, -2)
      for (const i of body) {
        const b = doc.blocks[i]
        if (!b || b.kind !== 'paragraph' || b.words === 0 || b.words > 6) continue
        const t = b.text.trim()
        if (!t.endsWith('?') || b.sentences.length > 1) continue
        spans.push({ block: i, start: b.text.indexOf(t), end: b.text.indexOf(t) + t.length })
      }
      return spans
    },
  },

  /* rhythm */
  {
    id: 'staccato',
    category: 'rhythm',
    label: 'Staccato run',
    why: '"No fluff. No filler. Just results." Fragments lined up for a drumbeat. Join them into one sentence that says something.',
    weight: 3,
    find(doc) {
      const spans: Span[] = []
      doc.blocks.forEach((b, i) => {
        if (b.kind !== 'paragraph') return
        let run: Sentence[] = []
        const flush = () => {
          // Three is a drumroll. Two is an antithesis ("Small change. Big
          // difference.") — but only when both halves are clipped, or every
          // short sentence that happens to follow another one gets flagged.
          const first = run[0]
          const last = run[run.length - 1]
          const pair = run.length === 2 && run.every((s) => s.words >= 2 && s.words <= 3)
          if (first && last && (run.length >= 3 || pair) && !isSignOff(b.text, first, last)) {
            spans.push({ block: i, start: first.start, end: last.end })
          }
          run = []
        }
        for (const s of b.sentences) {
          const body = b.text.slice(s.start, s.end)
          if (s.words >= 1 && s.words <= 4 && /\.$/.test(body) && !/\d/.test(body)) run.push(s)
          else flush()
        }
        flush()
      })
      return spans
    },
  },
  {
    id: 'triplet',
    category: 'rhythm',
    label: 'Rhythm triplet',
    why: '"Faster, cleaner, smarter." Three matched words chosen for the beat. Pick the one that is true, or use two.',
    weight: 1,
    find(doc) {
      const spans: Span[] = []
      // Exactly three: a fourth item before or after makes it a list, not a beat.
      const re = /(?<!, )\b([a-z]{4,}), ([a-z]{4,}),? (?:and |or )?([a-z]{4,})\b(?!,)/g
      doc.blocks.forEach((b, i) => {
        if (b.kind === 'heading') return
        for (const m of b.text.matchAll(re)) {
          const [, a = '', c = '', d = ''] = m
          const suffix = SUFFIXES.find((s) => a.endsWith(s))
          // Matched endings are what separate a cadence from a shopping list.
          if (suffix && c.endsWith(suffix) && d.endsWith(suffix)) {
            spans.push({ block: i, start: m.index, end: m.index + m[0].length })
          }
        }
      })
      return spans
    },
  },
]

// Comparatives, adverbs and adjectives. Not -ing or -ed: "boiled, scrambled or
// fried" is a real list of real things.
const SUFFIXES = ['ier', 'er', 'est', 'ly', 'able', 'ible', 'ful', 'ive', 'ous', 'less']

const SIGN_OFF = /^(?:thanks?(?: you| so much| again)?|cheers|enjoy|onward|aloha|best|later|peace|love|yours|until next (?:time|week)|see you (?:soon|then|friday|next week)|talk soon|more soon|that's it|that's all|p\.?s)\b/i

function isSignOff(text: string, first: Sentence, last: Sentence): boolean {
  return SIGN_OFF.test(text.slice(first.start, first.end)) || SIGN_OFF.test(text.slice(last.start, last.end))
}

/* ─────────────────────────────────────────────────────────────────── notes */

export const NOTES: NoteRule[] = [
  {
    id: 'even-sentences',
    category: 'rhythm',
    label: 'Every sentence the same length',
    why: 'People write a long sentence, then a short one. A model holds a steady fifteen to twenty words. Vary the length and the piece starts to sound spoken.',
    weight: 3,
    test(doc) {
      const lengths = doc.blocks
        .filter((b) => b.kind === 'paragraph')
        .flatMap((b) => b.sentences.map((s) => s.words))
        .filter((n) => n > 0)
      if (lengths.length < 12) return false
      const mean = lengths.reduce((a, n) => a + n, 0) / lengths.length
      const sd = Math.sqrt(lengths.reduce((a, n) => a + (n - mean) ** 2, 0) / lengths.length)
      // Coefficient of variation. Human prose usually lands well above 0.5.
      return mean >= 10 && sd / mean < 0.35
    },
  },
  {
    id: 'bullet-heavy',
    category: 'structure',
    label: 'More bullets than prose',
    why: 'An email that is mostly bullets reads as a generated summary. Bullets are for parallel items; ideas go in sentences.',
    weight: 3,
    test(doc) {
      const items = doc.blocks.filter((b) => b.kind === 'listItem').length
      const paras = doc.blocks.filter((b) => b.kind === 'paragraph' && b.words > 0).length
      return items >= 6 && items > paras
    },
  },
  {
    id: 'heading-then-bullets',
    category: 'structure',
    label: 'Heading, bullets, repeat',
    why: 'Section after section of a heading followed straight by a list is the house style of a chatbot.',
    weight: 3,
    test(doc) {
      let sections = 0
      doc.blocks.forEach((b, i) => {
        if (b.kind === 'heading' && doc.blocks[i + 1]?.kind === 'listItem' && doc.blocks[i + 2]?.kind === 'listItem') {
          sections++
        }
      })
      return sections >= 2
    },
  },
]
