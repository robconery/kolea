# 📰 The public site

Optional, off by default, and one variable to turn on. Set `SITE_URL` to a second
hostname on the same Worker and the archive becomes a blog:

- Newest-first cards with featured images, full-text search, and human-readable
  slugs
- A post page, an RSS feed carrying **the whole post** (owning the list means the
  reader gets all of it wherever they read), a sitemap, and OG tags. A members-only
  or Premium post carries its teaser in the feed instead
- A signup box that posts to your ordinary `/f/:slug` form endpoint, so consent
  arrives by exactly the same path as every other signup. There is no second implementation
- Server-rendered, no JavaScript, the same palette as the console, and a single
  column with an 18px gutter on a phone

**The post goes up as the mail goes out.** `publish_on_send` defaults to on, and it is
read at exactly one place: the `scheduled → sending` transition, the one moment every
send passes through whether you clicked Send or the cron picked it up. It happens
*before* a single message renders, so the "read this online" link in the mail resolves
the moment it lands instead of 404ing for your fastest reader. A publish failure is
caught and the send continues. The mail is the point, the page is the bonus.

Reading it in one place is what keeps the blast radius small. An import or a backfill
writes `status` directly and never comes through that function, so **a restored archive
stays inert**. A preview never publishes. And choosing **Email only** in the composer's
Web panel mails something without giving it a public URL, which is what a sales push or
a note to one segment wants.

**Publishing is still one decision per post.** `published_at` is nullable and otherwise
independent of the send lifecycle: a broadcast can go up months after it was mailed,
come down, and go back up, and none of that touches `status`, the segment, or the send
cursor. There is no bulk publish (not in `core/`, not in the admin, not in MCP)
because an archive imported from a previous ESP is hundreds of `sent` rows and "publish
everything" is a keystroke you can't take back.

**The mail carries "read this online" and a share link**, both built outside the body.
The body is the only thing click tracking rewrites, so the chrome stays untracked exactly like the
preference-center and download links. Both are omitted entirely when there is no
published post (a sequence step, a receipt, a broadcast taken down) rather than pointing
somewhere that 404s. The post page has a share link too: a plain link to
`x.com/intent/post`, not an embedded widget. No third-party script, and nothing
reporting who read what.

Featured images come from your own upload or from Unsplash search, built into the
composer's Web panel. Unsplash photos are hotlinked rather than copied, the download
endpoint is pinged only on a real pick, and the photographer's credit is stored on
the row and rendered under the image on the public page. That is where the reader is;
in the admin only you would see it.

**Topics organise the posts.** Tag a post in the composer's Web panel and the topic
exists. A post's first topic is the first part of its URL: tag it "AI" and it lives at
`/ai/its-slug`, and `/ai` lists everything under AI. A topic shows on the site once it
has a published post, and the busiest ones are the site's navigation. On **System →
Topics** you give each one a name and a description, and tick the ones that get a
shelf of their newest posts on the front page. Topics are not subscriber tags and
never send anything.

**Readers can sign in.** A member is a subscriber who signed in on the site. There is
no password. The reader types their address at `/members/sign-in` and is mailed a
link that works once, for 20 minutes. The session lasts 60 days. Signing in never adds
anyone to the list: an address that is not on it gets the same answer and no mail. New
people still join through the signup form. The link is transactional mail, so an
unsubscribed reader can still sign in.

**A post is for everyone, for members, or for Premium members.** Choose with **Who can
read it** in the composer's Web panel. Everyone is the default. A reader without
access sees the title, the excerpt you wrote, and a way to sign in or go Premium. The
feed carries the same teaser, and search reads only the title and that excerpt. The
choice is for the web only: the mail still goes to its whole segment, in full.

**Premium is the one paid level.** It is a monthly or yearly Stripe subscription on
your own Stripe account. Create the recurring prices in Stripe, then pick them on
**Money → Members**. Readers buy at `/premium` and sign in with the address they paid
with. Access is switched on by the signed Stripe webhook, never by the page the reader
returns to. While a payment is failing, Premium posts are closed to that reader.
Paying is not consent: a buyer who was not on the list is kept as `pending` and gets
no broadcasts, and an unsubscribed reader who pays stays unsubscribed. The Members
screen shows who pays, and which post converted them.

**Offer pages sell one product each.** On **Money → For sale**, put a product from
your Stripe catalog on sale at one of its one-time prices. It gets a page at
`/offers/<slug>` with a Buy button, and `/offers` lists everything on sale. Buy starts
a Stripe Checkout for one of that product. Link to an offer with `?from=` and the id
of a published post, and the checkout records that post as the one that converted the
buyer. The sale is booked by the Stripe webhook like any other, and no mail is sent:
purchase mail stays a button you press.

**The testimonials wall is at `/testimonials`.** Put `{{testimonial_link}}` in a
broadcast or a sequence mail and each reader gets their own link to a short form. A
testimonial shows on the wall only when the reader allowed publishing and you approved
it on **Audience → Testimonials**.

| For | You need |
|---|---|
| Sign-in, members-only posts | The `MEMBER_SESSION_SECRET` secret: any long random string. `bun run setup` writes a local one. Without it nobody can sign in, and gated posts show their teaser to everyone. Changing it signs every member out. |
| Premium | The above, plus a `STRIPE_SECRET_KEY` that may create Checkout Sessions (a read-only restricted key cannot), `STRIPE_WEBHOOK_SECRET`, and a price picked on Members. |
| Offer pages | `SITE_URL`, a `STRIPE_SECRET_KEY` that may create Checkout Sessions, and a product put on sale. |

**It is a separate Hono app, dispatched by hostname** before either router runs. The
admin app puts `requireOperator` on `*`; the way to be certain a reader's request
never enters it, and that a new admin route can never be exposed by being registered
above a line, is for the two never to share a router.

```jsonc
"SITE_URL": "https://www.example.com",   // unset = the site doesn't exist
"SITE_TITLE": "Your Publication",
"SITE_FORM_SLUG": "newsletter"           // omit to hide the signup box
```

---

[Back to the README](../README.md)
