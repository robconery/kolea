# 📰 The public site

Optional, off by default, and one variable to turn on. Set `SITE_URL` to a second
hostname on the same Worker and the archive becomes a blog:

- Newest-first cards with featured images, full-text search, and human-readable
  slugs
- A post page, an RSS feed carrying **the whole post** (owning the list means the
  reader gets all of it wherever they read), a sitemap, and OG tags
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
