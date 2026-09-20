import type { SequenceTemplate } from './types.ts'

/** Russell Brunson's shapes, from DotCom Secrets and Expert Secrets. */

export const soapOpera: SequenceTemplate = {
  slug: 'soap-opera',
  name: 'Soap Opera Sequence',
  family: 'funnel',
  source: 'Russell Brunson · DotCom Secrets',
  tagline: 'Five days, one story, every mail ends on a cliffhanger.',
  description: `The classic. Somebody just joined your list and has no idea who you are. You have about five days before they forget they signed up.

So you tell them one story, in five parts, and you stop each part right before the good bit. Daytime television has worked this way for seventy years because an open loop is physically uncomfortable to leave open.

By day five they know your backstory, the moment things changed for you, and the thing you built because of it. Only then do you ask for the sale.`,
  bestFor: [
    'Brand new subscribers who came in cold from an ad, a podcast or a lead magnet',
    'A single core offer you want every new person to hear about',
    'Anything where the seller’s story is part of why people buy',
  ],
  needs: [
    'One true story with a real low point and a real turning point',
    'One offer and a link to it',
    'The nerve to end an email mid-story',
  ],
  suggestedTrigger: 'subscribe',
  triggerHint: 'It is an introduction, so it starts the moment somebody joins.',
  defaultName: 'Start here',
  defaultDescription: 'A five-part introduction: who I am and how this all started',
  steps: [
    {
      delayDays: 0,
      label: 'Set the stage',
      purpose:
        'Say thanks, say what is coming, and open the first loop. Short. The only job is to get tomorrow’s mail opened.',
      subject: '[[ Chapter 1: a short, curious subject ]]',
      bodyMd: `Hey {{first_name}},

Thanks for signing up. [[ One line on what they asked for and where to get it, if there is a download. ]]

Over the next few days I'm going to tell you [[ the one thing you will share: a secret, a method, the story behind the thing ]]. It took me [[ how long ]] to figure out and it changed [[ what it changed ]].

It starts with [[ a one-line tease of the low point: the day the site went down, the email from my boss, the bank balance ]].

I'll tell you what happened tomorrow. Look for the subject line "[[ tomorrow's subject ]]".

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'High drama',
      purpose:
        'Start at the worst moment, then back up and explain how you got there. End right as you hit the wall.',
      subject: '[[ The low point, in a few words ]]',
      bodyMd: `[[ Open in the middle of the worst moment. No warm-up. Where were you, what had just happened, what did it feel like. Two or three short paragraphs. ]]

How did I get there?

[[ The backstory. What you wanted, what you tried, why the normal advice did not work for you. Keep it to the parts a reader will recognize from their own life. ]]

[[ The wall. The point where you ran out of obvious things to try. ]]

And that's when [[ tease the turning point without giving it away ]].

I'll tell you about that tomorrow.

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'The epiphany',
      purpose:
        'The turning point. What you realized, and how that realization leads straight to your offer.',
      subject: '[[ The thing I finally figured out ]]',
      bodyMd: `Yesterday I left you at [[ the wall, in one line ]].

Here's what happened next.

[[ The epiphany, told as a scene if you can. Who said what, what you read, what you noticed. The reader should reach the conclusion half a second before you state it. ]]

The thing I understood that day was this: [[ the one big idea, in a single plain sentence ]].

[[ What you did about it, and what happened. Real numbers if you have them. ]]

That idea is the whole reason [[ your product ]] exists. It is [[ one sentence on what it is ]].

[[ Link: you can see it here ]]

Tomorrow I want to show you something about it that most people miss.

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'Hidden benefits',
      purpose:
        'The benefits nobody expects. Not the headline feature, the thing customers tell you about six months later.',
      subject: '[[ What nobody tells you about X ]]',
      bodyMd: `Most people think [[ your product or method ]] is about [[ the obvious benefit ]].

It is. But that's not what people write to me about.

[[ Hidden benefit 1. Tell it through a customer if you can: who they were, what they expected, what they got instead. ]]

[[ Hidden benefit 2. ]]

[[ Hidden benefit 3, if you have a good one. Two strong beats three weak. ]]

If any of that sounds like what you're after: [[ link ]]

One more mail from me tomorrow, and it has a deadline in it.

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'Urgency and the ask',
      purpose:
        'The direct ask, with a real reason to act now. If the deadline is invented, leave it out and just ask.',
      subject: '[[ Last thing, and it closes tonight ]]',
      bodyMd: `{{first_name}}, this is the last part.

Over the past few days I've told you about [[ one-line recap of the story ]] and what it led to.

Here's the short version of the offer:

- [[ What they get ]]
- [[ What it costs ]]
- [[ The guarantee, if there is one ]]

[[ The real reason to act now: a price that goes up, a bonus that goes away, a cohort that starts. Only if it is true. ]]

[[ Link: get it here ]]

After this you'll just get my regular [[ newsletter name ]], [[ how often ]]. No more chapters.

[[ Sign off ]]`,
    },
  ],
}

const SEINFELD_LABELS = [
  'Something that happened',
  'Something that broke',
  'Something you overheard',
  'A confession',
  'A reader writes in',
  'A rant',
  'A look back',
]

const SEINFELD_PURPOSES = [
  'An ordinary thing from this week, told well. Sets the tone: this is a person writing, not a brand.',
  'A small failure. People trust the ones who admit to them.',
  'A conversation, a question, a line from a film. Borrowed stories count.',
  'Something you used to believe or do wrong. The turn writes itself.',
  'A reply or question from a subscriber, with their permission. Proof that people write back.',
  'An opinion you actually hold about your field. Pick a side.',
  'Recap the week, point at the offer once more, and tell them what happens next.',
]

const SEINFELD_PROMPTS = [
  'Something that happened to you this week that has nothing to do with work.',
  'Something that went wrong recently, and what you did about it.',
  'Something somebody said to you that stuck.',
  'Something you got wrong for years.',
  'A question a reader sent you, and your honest answer.',
  'Something in your industry that annoys you, and why.',
  'The week in review: which of these stories got the most replies, and what it made you think.',
]

export const seinfeldWeek: SequenceTemplate = {
  slug: 'seinfeld-week',
  name: 'Seinfeld Week',
  family: 'funnel',
  source: 'Russell Brunson · DotCom Secrets',
  tagline: 'Seven daily emails about nothing, each one tied back to the offer.',
  description: `Brunson's follow-up to the Soap Opera. Once the story is told, you stop writing lessons and start writing about your day. The kid's soccer game. The thing that broke. The strange email you got.

Each one is about nothing, the way the show was, and each one turns a corner in the last third and lands on the same offer.

Really this is a daily habit, not a fixed sequence. This template is a one-week starter so you can find out whether the voice suits you before you commit to it.`,
  bestFor: [
    'People who just finished a Soap Opera Sequence',
    'Writers with a personality and a life they are willing to talk about',
    'Keeping one offer warm without sending a sales letter every day',
  ],
  needs: [
    'Seven small true stories. They can be very small.',
    'One offer to tie them to',
    'A tolerance for daily email, yours and theirs',
  ],
  suggestedTrigger: 'manual',
  triggerHint:
    'Enroll people by hand or by tag after the introduction is done. Daily mail to a cold subscriber is a lot.',
  defaultName: 'Daily notes',
  defaultDescription: 'A week of short daily notes and stories',
  steps: [1, 2, 3, 4, 5, 6, 7].map((day) => ({
    delayDays: day === 1 ? 0 : 1,
    label: SEINFELD_LABELS[day - 1]!,
    purpose: SEINFELD_PURPOSES[day - 1]!,
    subject: `[[ Day ${day}: an odd, specific subject line from the story ]]`,
    bodyMd: `[[ ${SEINFELD_PROMPTS[day - 1]} Tell it like you would to a friend. Four to eight short paragraphs. ]]

[[ The turn. One sentence that connects the story to the thing you sell. "Which is exactly what happens when..." ]]

[[ Two or three lines on the offer and what it fixes. ]]

[[ Link ]]

[[ Sign off ]]

P.S. [[ A second, shorter reason to click. Many people only read this line. ]]`,
  })),
}

export const webinarReplay: SequenceTemplate = {
  slug: 'webinar-follow-up',
  name: 'Webinar Follow-up',
  family: 'funnel',
  source: 'Russell Brunson · Expert Secrets (the Perfect Webinar)',
  tagline: 'Replay, three secrets, the stack, and a cart that really closes.',
  description: `The Perfect Webinar breaks three false beliefs, one per "secret", then stacks the offer. Most of the sales come afterwards, from the mail, and most of those come on the last day.

This sequence walks the same path the webinar did. The replay first, then one mail for each secret, then the stack and the close.

Tag people when the webinar ends and let the tag start the series. That way it runs on the same clock for everybody who attended or registered.`,
  bestFor: [
    'The days after a live webinar, workshop or masterclass',
    'An evergreen recorded class with an offer at the end',
    'Any pitch built on three beliefs the buyer has to let go of',
  ],
  needs: [
    'A replay link',
    'The three secrets from the talk, each with its story',
    'An offer with a real closing date',
  ],
  suggestedTrigger: 'tag_added',
  triggerHint: 'Tag attendees and registrants when the session ends. The tag starts the clock.',
  defaultName: 'Workshop follow-up',
  defaultDescription: 'The replay and follow-up notes from the workshop',
  steps: [
    {
      delayDays: 0,
      label: 'The replay',
      purpose: 'Get the replay in front of everybody, including the people who registered and did not show.',
      subject: '[[ The replay is up (for a few days) ]]',
      bodyMd: `Hey {{first_name}},

The replay of [[ webinar name ]] is ready: [[ replay link ]]

If you couldn't make it, here's what we covered:

- [[ Secret 1, as a curiosity line ]]
- [[ Secret 2 ]]
- [[ Secret 3 ]]

It comes down on [[ date ]], so don't save it for later.

At the end I talk about [[ the offer ]]. That closes on [[ close date ]] too. Details here: [[ offer link ]]

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'Secret one: the vehicle',
      purpose: 'Break the belief that this whole approach will not work. Tell the origin story again, shorter.',
      subject: '[[ Why X works when Y does not ]]',
      bodyMd: `A lot of people told me after the session: "[[ the false belief about the method itself ]]".

I believed that too. Then [[ the short version of the story that changed your mind ]].

[[ The new belief, stated plainly. ]]

That's the first thing [[ offer name ]] is built on. [[ offer link ]]

Replay is still here if you missed it: [[ replay link ]]

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'Secrets two and three',
      purpose:
        'Break the internal belief ("I could not do it") and the external one ("something outside me will stop me").',
      subject: '[[ "That works for you, but..." ]]',
      bodyMd: `The second thing I hear: "[[ the false belief about themselves: not technical enough, no time, no audience ]]".

[[ A customer or student story that kills it. Somebody less qualified than the reader who did it anyway. ]]

And the third: "[[ the external excuse: the market, the boss, the budget, the timing ]]".

[[ The story or the fact that answers it. ]]

Here is everything that's in [[ offer name ]]:

- [[ Stack item 1 and what it's worth ]]
- [[ Stack item 2 ]]
- [[ Stack item 3 ]]
- [[ Bonuses ]]

[[ Price, and the link ]]

Closes [[ close date ]].

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'Questions',
      purpose: 'Answer the real objections from the chat and your inbox. Refund terms, time needed, who it is not for.',
      subject: '[[ Your questions about X, answered ]]',
      bodyMd: `I've had a lot of replies about [[ offer name ]]. Here are the ones that keep coming up.

**[[ Question 1 ]]**
[[ Straight answer. ]]

**[[ Question 2 ]]**
[[ Straight answer. ]]

**[[ Question 3: who is this not for? ]]**
[[ Be honest. Telling the wrong people to stay away is what makes the right ones trust you. ]]

**[[ What if it doesn't work for me? ]]**
[[ The guarantee, in plain words. ]]

The doors close [[ close date and time, with time zone ]].

[[ Link ]]

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'Closing',
      purpose: 'Last day. Short, factual, one link. Then actually close.',
      subject: '[[ Closing tonight ]]',
      bodyMd: `{{first_name}}, quick one.

[[ Offer name ]] closes tonight at [[ time and time zone ]]. The replay comes down at the same time.

[[ Two sentences on who should grab it. ]]

[[ Link ]]

If it's not for you, no problem at all. This is the last mail about it.

[[ Sign off ]]`,
    },
  ],
}
