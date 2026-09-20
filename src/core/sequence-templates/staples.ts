import type { SequenceTemplate } from './types.ts'

export const valueWelcome: SequenceTemplate = {
  slug: 'value-first-welcome',
  name: 'Value-First Welcome',
  family: 'welcome',
  source: 'Graham Cochrane · How to Get Paid for What You Know',
  tagline: 'Give, give, give, ask a question, then make a quiet offer.',
  description: `Cochrane's whole model is generosity on a schedule. Free content every week, a simple welcome series, and a product for the people who want to go faster.

The welcome series does three things. It delivers what was promised. It shows new people your best free work, so they understand what they signed up for. And it asks them one question, "what are you struggling with?", which is the best market research you will ever get.

The offer comes last and it is soft. Nobody is pushed. The people who are ready will click.`,
  bestFor: [
    'Teachers, creators and anybody whose free content is the top of the funnel',
    'A list that feeds a course, a membership or coaching',
    'People who dislike hard selling and want a series they are comfortable sending',
  ],
  needs: [
    'Two or three of your best free pieces',
    'A short version of your own story',
    'One paid product, even a small one',
  ],
  suggestedTrigger: 'subscribe',
  triggerHint: 'It is the welcome, so it starts when they join.',
  defaultName: 'Welcome series',
  defaultDescription: 'A short welcome: my best free material and how to get the most from it',
  steps: [
    {
      delayDays: 0,
      label: 'Welcome and deliver',
      purpose: 'Hand over what they signed up for. Say who you are in two lines and what they will get from you.',
      subject: '[[ Welcome! Here is your THING ]]',
      bodyMd: `Hey {{first_name}},

Welcome. Here's [[ the thing they signed up for ]]: [[ link ]]

I'm [[ name ]]. I [[ one line on what you do and who you help ]].

Here's what to expect: [[ what you send and how often, e.g. one new video every Tuesday ]]. All free.

Over the next week I'll also send you a few of my best things, so you don't have to dig for them.

[[ Sign off ]]

P.S. Do me a favor and reply with a quick "got it" so I know this reached you. It also helps keep my mail out of your spam folder.`,
    },
    {
      delayDays: 1,
      label: 'Your story',
      purpose: 'Why you do this. Short, honest, and aimed at the reader seeing themselves in it.',
      subject: '[[ How I ended up doing this ]]',
      bodyMd: `I want to tell you quickly how I got here, because it explains why I do things the way I do.

[[ Where you were before. The job, the frustration, the thing that was not working. ]]

[[ What changed. Keep it to one turning point. ]]

[[ What you believe now because of it, and what that means for the reader. ]]

That's why [[ your site or channel ]] exists. [[ One line on the mission. ]]

Tomorrow: the best place to start.

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'Best of',
      purpose: 'Your strongest free material, curated. A quick win builds more trust than any pitch.',
      subject: '[[ Start here: my 3 best X ]]',
      bodyMd: `There's a lot on [[ your site or channel ]], so here's where I'd start.

1. **[[ Title ]]**: [[ one line on what they'll get from it ]]. [[ link ]]
2. **[[ Title ]]**: [[ one line ]]. [[ link ]]
3. **[[ Title ]]**: [[ one line ]]. [[ link ]]

If you only have ten minutes, make it number [[ N ]]. [[ Why. ]]

[[ Sign off ]]`,
    },
    {
      delayDays: 2,
      label: 'The question',
      purpose:
        'Ask what they are stuck on and ask them to reply. The answers tell you what to make next, and replies help deliverability.',
      subject: '[[ Quick question ]]',
      bodyMd: `{{first_name}}, one question:

**What's the number one thing you're struggling with in [[ your topic ]] right now?**

Hit reply and tell me. A sentence is plenty.

I read every reply, and the answers decide what I make next. [[ An example of something you made because a reader asked. ]]

[[ Sign off ]]`,
    },
    {
      delayDays: 2,
      label: 'The quiet offer',
      purpose: 'Mention the paid thing for people who want to go faster. No deadline, no pressure.',
      subject: '[[ If you want to go faster ]]',
      bodyMd: `Everything I've sent you so far is free, and the weekly [[ videos / posts ]] always will be.

Some people want the whole thing in order, without hunting for it. That's what [[ product name ]] is. [[ Two sentences on what it is and the result it gets. ]]

[[ A short line of proof: a number, a quote. ]]

You can look at it here: [[ link ]]

If it's not for you, that's completely fine. You'll keep hearing from me every [[ day of week ]] either way.

[[ Sign off ]]`,
    },
  ],
}

export const newsletterWelcome: SequenceTemplate = {
  slug: 'newsletter-welcome',
  name: 'Newsletter Welcome',
  family: 'welcome',
  source: 'The standard newsletter onboarding',
  tagline: 'Three short mails: what this is, the greatest hits, and one question.',
  description: `The lightest welcome there is. No story arc and no offer. It just makes sure that the first thing a new subscriber gets from you is not a random issue three weeks later.

A welcome mail is the most-opened mail you will ever send. Use it to say what the newsletter is, when it arrives, and to get a reply. A reply teaches their mail client that you are a person they talk to.`,
  bestFor: [
    'A newsletter with no product behind it, or not yet',
    'Signup forms on a blog or a personal site',
    'A starting point you can grow into a longer series',
  ],
  needs: ['A sentence that describes the newsletter', 'Three past issues or posts you are proud of'],
  suggestedTrigger: 'subscribe',
  triggerHint: 'Starts when somebody joins the list.',
  defaultName: 'Welcome',
  defaultDescription: 'A short welcome to the newsletter',
  steps: [
    {
      delayDays: 0,
      label: 'What this is',
      purpose: 'Confirm they are in, say what arrives and when, and ask for a reply.',
      subject: '[[ You are in. Here is what to expect ]]',
      bodyMd: `Hey {{first_name}},

Thanks for subscribing to [[ newsletter name ]].

Here's the deal: [[ what you write about ]], [[ how often, and what day ]]. [[ One line on what makes it different from the others in their inbox. ]]

One small favor. Hit reply and tell me [[ an easy question: what you do, or how you found me ]]. I read everything, and it stops this landing in your promotions tab.

[[ Sign off ]]`,
    },
    {
      delayDays: 2,
      label: 'Greatest hits',
      purpose: 'Three past pieces, so the wait for the next issue is not empty.',
      subject: '[[ Three things to read while you wait ]]',
      bodyMd: `The next issue is on its way. Until then, these are the ones people forward the most:

- **[[ Title ]]**: [[ one line ]]. [[ link ]]
- **[[ Title ]]**: [[ one line ]]. [[ link ]]
- **[[ Title ]]**: [[ one line ]]. [[ link ]]

[[ Sign off ]]`,
    },
    {
      delayDays: 3,
      label: 'One question',
      purpose: 'Find out what they want. Then get out of the way and let the regular issues take over.',
      subject: '[[ What should I write about? ]]',
      bodyMd: `Last of the welcome mails, and it's a short one.

What's one thing about [[ your topic ]] you wish somebody would explain properly?

Reply and tell me. A good chunk of what I write starts as an answer to one of these.

From here you'll just get the regular issues. See you [[ day ]].

[[ Sign off ]]`,
    },
  ],
}

export const leadMagnet: SequenceTemplate = {
  slug: 'lead-magnet-to-offer',
  name: 'Lead Magnet to Offer',
  family: 'funnel',
  source: 'The standard lead-magnet funnel',
  tagline: 'Deliver the download, get them a quick win, then offer the next step.',
  description: `Somebody traded their address for a PDF, a checklist, a free chapter or a mini course. Most of them will never open it.

This sequence delivers the thing, then spends two mails getting them to actually use it, because a person who got a result from your free thing is the only kind who buys your paid thing.

The offer arrives once they have had the quick win, and it is framed as the rest of the path they are already on.`,
  bestFor: [
    'A free download, checklist, template or sample chapter for a business',
    'Separate funnels for separate lead magnets, each started by its own tag',
    'Products that are the obvious next step after the free thing',
  ],
  needs: [
    'The download link',
    'One paid offer that continues what the download started',
    'A customer story, even a small one',
  ],
  suggestedTrigger: 'tag_added',
  triggerHint:
    'Have the signup form add a tag for this download. The tag starts this series and leaves your other signups alone.',
  defaultName: 'Your download',
  defaultDescription: 'Your download, plus a few notes on getting the most from it',
  steps: [
    {
      delayDays: 0,
      label: 'Deliver',
      purpose: 'The link, at the top, immediately. Then one instruction: the first thing to do with it.',
      subject: '[[ Here is your DOWNLOAD NAME ]]',
      bodyMd: `Hey {{first_name}},

Here it is: [[ download link ]]

Don't file it away for later. Open it now and do this one thing first: [[ the single smallest useful action, e.g. fill in page 2 ]]. It takes about [[ N ]] minutes.

Tomorrow I'll show you the part most people skip.

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'The quick win',
      purpose: 'Walk them through getting one real result from the download.',
      subject: '[[ The part most people skip ]]',
      bodyMd: `Did you get a chance to open [[ download name ]]?

If not, here's the link again: [[ download link ]]

The part I'd point you to is [[ section or step ]]. Here's why: [[ the result it gets, as concretely as you can ]].

[[ A short walkthrough, three to five steps. ]]

Try it and reply to tell me how it went. I'm curious.

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'The common mistake',
      purpose: 'Name the mistake that keeps people stuck. This is the mail that sets up the need for the paid product.',
      subject: '[[ The mistake I see with X ]]',
      bodyMd: `I've watched a lot of people try to [[ the goal ]], and nearly all of them hit the same problem.

[[ The mistake. Describe it so the reader recognizes themselves. ]]

[[ Why it happens. It's not their fault: the usual advice points them this way. ]]

[[ What to do instead, in brief. Give them the real answer, not a teaser. ]]

[[ Download name ]] gets you started on this. Doing it properly takes [[ what it takes ]], and I'll tell you more about that tomorrow.

[[ Sign off ]]`,
    },
    {
      delayDays: 1,
      label: 'A customer story',
      purpose: 'Somebody who started where the reader is now and went further with the paid product.',
      subject: '[[ How NAME went from A to B ]]',
      bodyMd: `[[ Customer name ]] downloaded the same [[ download name ]] you did.

[[ Where they were at the time. ]]

[[ What they did next: they picked up your paid product. What it let them do that the free thing could not. ]]

[[ Where they ended up. ]]

That product is [[ product name ]]: [[ one sentence on what it is ]].

[[ Link ]]

[[ Sign off ]]`,
    },
    {
      delayDays: 2,
      label: 'The offer',
      purpose: 'Lay the offer out plainly: what is in it, what it costs, the guarantee.',
      subject: '[[ The next step after DOWNLOAD NAME ]]',
      bodyMd: `{{first_name}}, if [[ download name ]] was useful, this is the rest of it.

**[[ Product name ]]**

- [[ What's inside, item 1 ]]
- [[ Item 2 ]]
- [[ Item 3 ]]

[[ Price. ]] [[ Guarantee. ]]

[[ Link ]]

[[ A new-subscriber bonus or discount with an end date, only if you really have one. ]]

[[ Sign off ]]`,
    },
    {
      delayDays: 2,
      label: 'Last word',
      purpose: 'One reminder, the top question answered, and a clear statement that the pitch is over.',
      subject: '[[ One last thing about PRODUCT ]]',
      bodyMd: `Last mail about [[ product name ]], then I'll leave you alone about it.

The question I get most is: [[ the top objection ]].

[[ The honest answer. ]]

If that was the thing holding you back: [[ link ]]

If not, no hard feelings. You'll keep getting [[ your regular newsletter ]] and I hope [[ download name ]] keeps being useful.

[[ Sign off ]]`,
    },
  ],
}

export const customerOnboarding: SequenceTemplate = {
  slug: 'new-customer',
  name: 'New Customer Onboarding',
  family: 'customer',
  source: 'The standard post-purchase series',
  tagline: 'Thanks, first steps, a check-in, a review request, and what is next.',
  description: `The most neglected sequence in email. Somebody just paid you. They have never been more interested in hearing from you, and most sellers send a receipt and go quiet.

This series makes sure they actually use what they bought. That means fewer refunds, better reviews, and a second sale that needs no persuading.

It is separate from the purchase receipt, which goes out right away as transactional mail. This one is a sequence, so a customer can leave it without leaving anything else.`,
  bestFor: [
    'Courses, books, software, memberships: anything with a "getting started"',
    'Cutting refunds that come from people who bought and never began',
    'Collecting testimonials on a schedule',
  ],
  needs: [
    'A tag that lands on people when they buy',
    'A clear first step inside the product',
    'A place for reviews, or just a reply-to address',
  ],
  suggestedTrigger: 'tag_added',
  triggerHint: 'Use the tag that a purchase adds. One onboarding series per product.',
  defaultName: 'Getting started',
  defaultDescription: 'Getting-started notes for your purchase',
  steps: [
    {
      delayDays: 0,
      label: 'Thank you',
      purpose: 'A human thank-you and the single first step. The receipt already covered access.',
      subject: '[[ Thank you, and where to start ]]',
      bodyMd: `{{first_name}}, thank you for buying [[ product name ]]. It means a lot, truly.

You should already have your access details in a separate mail. If not, reply to this and I'll sort it out.

The best first step is [[ the first thing to do: watch lesson 1, read chapter 2, run the installer ]]. It takes about [[ N minutes ]] and [[ what they will have when it's done ]].

Over the next couple of weeks I'll send a few short notes to help you get the most from it.

[[ Sign off ]]`,
    },
    {
      delayDays: 2,
      label: 'Quick start',
      purpose: 'The fastest route to a first result, for the people who have not started.',
      subject: '[[ The fastest way through PRODUCT ]]',
      bodyMd: `If you've already dug in, great, skip this one.

If life got in the way, here's the short path:

1. [[ Step 1 ]]
2. [[ Step 2 ]]
3. [[ Step 3 ]]

That's enough to [[ the first real result ]]. Everything else can wait.

[[ A tip that most customers find late. ]]

[[ Sign off ]]`,
    },
    {
      delayDays: 5,
      label: 'Check in',
      purpose: 'Ask how it is going. Catch confused customers before they become refund requests.',
      subject: '[[ How is it going? ]]',
      bodyMd: `{{first_name}}, you've had [[ product name ]] for about a week now.

How's it going? Stuck anywhere?

Reply and tell me. If something is confusing, that's on me, and I want to fix it.

[[ Links to help: docs, community, FAQ. ]]

[[ Sign off ]]`,
    },
    {
      delayDays: 7,
      label: 'The review',
      purpose: 'Ask for a review or a testimonial once they have had time to get a result.',
      subject: '[[ Could I ask a favor? ]]',
      bodyMd: `If [[ product name ]] has been useful, would you tell me about it?

[[ Where to leave it: a review link, or just "hit reply". ]]

Two or three sentences is perfect. The most helpful thing to mention is [[ a prompt: what you were trying to do, and what changed ]].

I'm a small operation and these make a real difference.

And if it has NOT been useful, I want to hear that even more. Same reply button.

[[ Sign off ]]`,
    },
    {
      delayDays: 7,
      label: 'What is next',
      purpose: 'The natural next product, offered to somebody who has finished or nearly finished this one.',
      subject: '[[ Where to go after PRODUCT ]]',
      bodyMd: `By now you're probably well into [[ product name ]], so here's the question I get at this point: what next?

[[ The next logical product or step, and why it follows. ]]

[[ A customer discount, if you offer one. ]]

[[ Link ]]

No rush on any of it. This is the last of the getting-started notes. Thanks again for being a customer.

[[ Sign off ]]`,
    },
  ],
}

export const winBack: SequenceTemplate = {
  slug: 'win-back',
  name: 'Win-Back',
  family: 'customer',
  source: 'The standard re-engagement series',
  tagline: 'Three mails to people who went quiet. The last one tells them how to leave.',
  description: `People who have not opened in months hurt your deliverability and cost you money. Before you stop mailing them, give them one fair chance to say they still want in.

Three mails. An honest "still interested?", then your best recent work, then a plain goodbye with the preference link.

Nothing here unsubscribes anybody automatically. Consent only moves when the reader moves it. What you do with the people who stay silent is a separate decision, made with a segment.`,
  bestFor: [
    'Subscribers with no opens or clicks in 90 days or more',
    'Cleaning a list before a launch',
    'An old imported list you are not sure about',
  ],
  needs: [
    'A segment or tag for the quiet people',
    'One or two recent pieces that show what they have been missing',
  ],
  suggestedTrigger: 'manual',
  triggerHint: 'Enroll the quiet segment by hand, or tag them. Never run this on subscribe.',
  defaultName: 'Checking in',
  defaultDescription: 'A short check-in to see if you still want these emails',
  steps: [
    {
      delayDays: 0,
      label: 'Still interested?',
      purpose: 'Name the silence without guilt. One click says "yes, keep me".',
      subject: '[[ Still want these? ]]',
      bodyMd: `Hey {{first_name}},

I noticed you haven't opened my mail in a while. No hard feelings. Inboxes are a mess and interests change.

If you still want to hear from me, click here and I'll know: [[ a link to anything: your latest post is fine ]]

If not, you don't need to do a thing. There's a link at the bottom of this mail to change what you get from me.

[[ Sign off ]]`,
    },
    {
      delayDays: 4,
      label: 'What you missed',
      purpose: 'Your best recent work. Remind them why they signed up.',
      subject: '[[ The best thing I made this year ]]',
      bodyMd: `In case it's useful, here's the best of what I've put out lately:

- **[[ Title ]]**: [[ one line ]]. [[ link ]]
- **[[ Title ]]**: [[ one line ]]. [[ link ]]

[[ One line on what's coming up that they might care about. ]]

[[ Sign off ]]`,
    },
    {
      delayDays: 5,
      label: 'Goodbye, maybe',
      purpose: 'A plain last call. Tell them where the preference link is and mean it.',
      subject: '[[ Should I stop sending these? ]]',
      bodyMd: `{{first_name}}, this is the last check-in.

I only want to mail people who want the mail. If that's you, click anything in this message and you're all set: [[ link ]]

If it's not, the link in the footer lets you leave this series or everything, your call. I won't take it personally.

Thanks for reading for as long as you did.

[[ Sign off ]]`,
    },
  ],
}
