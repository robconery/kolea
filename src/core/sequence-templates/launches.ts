import type { SequenceTemplate } from './types.ts'

export const productLaunch: SequenceTemplate = {
  slug: 'product-launch-formula',
  name: 'Product Launch',
  family: 'launch',
  source: 'Jeff Walker · Launch (Product Launch Formula)',
  tagline: 'Three pieces of free content, then an open cart with a hard close.',
  description: `Walker's sideways sales letter. Rather than one long pitch, you give away three genuinely useful pieces of prelaunch content over about a week. Each one does a job: the opportunity, the transformation, the ownership experience.

Then the cart opens for a fixed window, usually five days, and it really closes.

By the time you ask for money the reader has had three wins from you and has watched other people get excited in the comments. The sale is the natural next step and not an interruption.`,
  bestFor: [
    'A new course, book, cohort or membership',
    'Reopening something that is only sold a few times a year',
    'An audience that already knows you a little',
  ],
  needs: [
    'Three pieces of prelaunch content: videos, posts or PDFs',
    'A sales page and a cart that can open and close',
    'Dates you will stick to',
  ],
  suggestedTrigger: 'tag_added',
  triggerHint:
    'Tag the people who raise their hand for the launch. The series runs on a relative clock, so tag everybody on the same day.',
  defaultName: 'Launch series',
  defaultDescription: 'The free training series and launch announcements',
  steps: [
    {
      delayDays: 0,
      label: 'PLC 1 · The opportunity',
      purpose:
        'Show the change that is possible and why you are the one to show it. Teach something real. Ask for comments.',
      subject: '[[ Video 1: the opportunity, as a promise ]]',
      bodyMd: `Hey {{first_name}},

The first part of [[ series name ]] is up: [[ link to content 1 ]]

In this one:

- [[ The opportunity: what is possible now that was not before ]]
- [[ Why most people miss it ]]
- [[ One thing they can use today, whether or not they ever buy ]]

When you've watched it, leave a comment and tell me [[ a specific question: your biggest obstacle with X ]]. I read all of them and they shape the next two parts.

Part two lands in [[ two ]] days.

[[ Sign off ]]`,
    },
    {
      delayDays: 2,
      label: 'PLC 2 · The transformation',
      purpose: 'Teach the core method. Prove it works with a case study. Answer the top objection from the comments.',
      subject: '[[ Video 2: how it actually works ]]',
      bodyMd: `Part two is live: [[ link to content 2 ]]

The comments on part one were great. The thing that came up most was [[ the top objection or question ]], so I start there.

Then I walk through [[ the method, named ]], step by step, and show you [[ case study: who, what they did, what happened ]].

[[ One line of real teaching they can take away even if they never click. ]]

Part three is the one that puts it all together. [[ Two ]] days.

[[ Sign off ]]`,
    },
    {
      delayDays: 2,
      label: 'PLC 3 · The ownership experience',
      purpose: 'Show what life looks like with the result in hand, then pivot: mention that an offer is coming and when.',
      subject: '[[ Video 3: putting it together ]]',
      bodyMd: `The last part of the series is up: [[ link to content 3 ]]

This one covers [[ what part three teaches ]] and answers the questions from the first two.

One more thing. A lot of you have asked how to go further with this. On [[ open date ]] I'm opening [[ product name ]]. It's [[ one sentence on what it is and who it's for ]].

It will only be open until [[ close date ]], and [[ the honest reason it closes: a cohort, limited seats, a price change ]].

I'll send the details when the doors open. Watch part three first.

[[ Sign off ]]`,
    },
    {
      delayDays: 2,
      label: 'Cart open',
      purpose: 'Short and clear. It is open, here is the link, here is when it closes.',
      subject: '[[ Product name is open ]]',
      bodyMd: `{{first_name}}, we're open.

[[ Product name ]]: [[ sales page link ]]

Everything is on that page: what's inside, what it costs, the guarantee, and the bonuses for joining this round.

Doors close [[ close date and time, with time zone ]].

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'Proof',
      purpose: 'Other people’s results. One detailed story beats ten one-line testimonials.',
      subject: '[[ How NAME did X ]]',
      bodyMd: `I want to tell you about [[ a customer ]].

[[ Where they started. Make it a place the reader recognizes. ]]

[[ What they did with the method. Specifics. ]]

[[ Where they are now. Numbers if you have them, their own words if you can quote them. ]]

[[ Two or three shorter results from other people. ]]

[[ Product name ]] is open until [[ close date ]]: [[ link ]]

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'Questions',
      purpose: 'The mid-cart lull. Answer every real objection in one mail.',
      subject: '[[ Is PRODUCT right for you? ]]',
      bodyMd: `The questions I've had most since we opened:

**[[ How much time does it take? ]]**
[[ Answer. ]]

**[[ I'm a beginner / I'm advanced. Is it for me? ]]**
[[ Answer. Say who should not buy. ]]

**[[ What if I don't like it? ]]**
[[ The guarantee. ]]

**[[ Can I get it later? ]]**
[[ The honest answer about when it opens again and at what price. ]]

Anything else, just reply. I answer these myself.

[[ Link ]]. Closes [[ close date ]].

[[ Sign off ]]`,
    },
    {
      delayDays: 2,
      label: 'Closing day',
      purpose: 'Closing day carries a large share of launch sales. Short, factual, final.',
      subject: '[[ Doors close tonight ]]',
      bodyMd: `{{first_name}}, last call.

[[ Product name ]] closes tonight at [[ time and time zone ]].

[[ One paragraph: the result, who it's for, what happens if they do nothing. No hype. ]]

[[ Link ]]

This is the last mail about it. Thanks for following along with the series either way.

[[ Sign off ]]`,
    },
  ],
}

export const bigSale: SequenceTemplate = {
  slug: 'big-sale',
  name: 'The Big Sale',
  family: 'sale',
  source: 'The standard promotion calendar',
  tagline: 'Five mails in five days: announce, reason why, proof, one day left, last day.',
  description: `Black Friday, a birthday sale, a price rise, the end of a version. Any promotion with a start and an end.

The thing that makes a sale work is a believable reason for it. "Because it's November" is fine. "Because I felt like it" is not. Say the reason out loud in the second mail.

Half the revenue usually lands at the very end, so the last two days each get a mail. Steps are spaced in whole days, so a same-day "final hours" note is better sent as a broadcast. People who aren't interested can leave this series from the footer and stay on your newsletter, which is the point of running it as a sequence.`,
  bestFor: [
    'A seasonal or anniversary sale',
    'A price increase with a last chance at the old price',
    'Clearing out a product before a new version',
  ],
  needs: ['A discount or bonus with an end date', 'A true reason for the sale', 'A checkout link or coupon code'],
  suggestedTrigger: 'manual',
  triggerHint:
    'Enroll the segment you want on the morning the sale starts. Everybody then runs on the same clock.',
  defaultName: 'Sale announcements',
  defaultDescription: 'Announcements about the current sale',
  steps: [
    {
      delayDays: 0,
      label: 'Announce',
      purpose: 'What is on sale, how much off, until when. All of it visible without scrolling.',
      subject: '[[ X% off PRODUCT until DAY ]]',
      bodyMd: `Hey {{first_name}},

[[ The sale in one sentence: what, how much off, until when. ]]

[[ Link or button ]]

[[ Coupon code, if there is one, on its own line. ]]

[[ Two or three lines on what the product is, for people who have not seen it. ]]

Ends [[ day, time, time zone ]].

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'The reason why',
      purpose: 'Why this sale, why now. A discount with a reason reads as an event. One without reads as desperation.',
      subject: '[[ Why I am doing this ]]',
      bodyMd: `A few people asked why [[ product ]] is [[ X% ]] off this week. Fair question, because I don't do this often.

[[ The true reason. An anniversary, a new version coming, a milestone, a price rise next month. Tell it as a short story. ]]

[[ Who this is a particularly good deal for. ]]

[[ Link ]]

Ends [[ day ]].

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'Proof',
      purpose: 'What buyers say. Let somebody else do the selling for a day.',
      subject: '[[ "A quote from a customer" ]]',
      bodyMd: `I got this from [[ customer name ]] [[ when ]]:

> [[ The quote. Keep their words, typos and all. ]]

[[ A little context: who they are, what they were trying to do. ]]

[[ One or two more short ones. ]]

[[ Product ]] is [[ X% ]] off until [[ day ]]: [[ link ]]

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'One day left',
      purpose: 'The day before it ends. Restate the whole offer for people who skipped the first three.',
      subject: '[[ Ends tomorrow ]]',
      bodyMd: `{{first_name}}, the sale ends tomorrow night.

- [[ What's on sale ]]
- [[ The price now, and the price after ]]
- [[ Code, if any ]]

[[ Link ]]

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'Last day',
      purpose: 'Three lines. The deadline, the link, and a promise that this is the last one.',
      subject: '[[ Last day ]]',
      bodyMd: `Last note on this, I promise.

[[ X% off product ]] ends tonight at [[ time, time zone ]]. After that it's back to [[ full price ]].

[[ Link ]]

[[ Sign off ]]`,
    },
  ],
}
