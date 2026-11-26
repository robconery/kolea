# 💸 What Kōlea costs to run

Running it locally costs nothing. Running it for real costs **about $25 a month** for most
lists under 50,000 emails a month: $5 to Cloudflare and $20 to Resend. Both are flat
fees. Kōlea doesn't charge you per subscriber the way a hosted ESP does, so a list
that grows from 500 to 15,000 people costs about the same to run.

### 🧾 The services, and which tier you need

| Service | What Kōlea uses it for | Tier you need | Cost |
|---|---|---|---|
| **Cloudflare Workers** | The app itself, plus D1 (the database), Queues (sending) and Cron (schedules) | **Workers Paid** | **$5/month** |
| **Cloudflare R2** | Uploaded images and lead-magnet files | Free tier: 10 GB, no bandwidth charges | Free for almost everyone. $0.015/GB-month past 10 GB |
| **Cloudflare Zero Trust** | The login in front of your admin console | Free plan. You're one user | Free. Cloudflare asks for a card when you sign up |
| **A domain on Cloudflare** | Your admin host, your site, your sending address | Any registrar. Cloudflare just has to run its DNS | What you already pay, roughly $10 to $15/year |
| **Resend** | Putting mail on the wire | **Pro** once you send more than 100 emails a day | Free up to 100/day and 3,000/month. **$20/month** for 50,000, then $0.90 per 1,000 |
| **Stripe** *(optional)* | Crediting sales to the mail that earned them | Your existing account | Nothing extra. Kōlea only reads |
| **Unsplash** *(optional)* | Stock photos when you publish a post | Free demo tier (50 searches an hour) | Free |
| **OpenRouter** *(optional)* | AI writing help | Pay as you go | Pennies per use. Capped at $10/month unless you change it |

Resend's separate "Marketing" plans are priced per contact. You don't need them: Kōlea
does the list management itself and only uses Resend to send.

### ⚠️ Why not the free Cloudflare plan?

Queues used to be paid-only, and they aren't anymore. But the free Workers plan has
three other limits that stop Kōlea from sending, even for a small list:

| Limit | Free | Paid | What breaks |
|---|---|---|---|
| Database queries per request | 50 | 1,000 | Kōlea writes send records 10 at a time, so a 500-person broadcast needs ~50 writes before anything else. Sequences process 200 people per tick. Both would stall. |
| CPU time per request | 10 ms | 30 s | Building a batch of 100 personalised emails takes far more than 10 ms. |
| Resend free tier | 100 emails/day | $20/mo for 50k | A 500-person broadcast is blocked by Resend before Cloudflare even matters. |

The $5 includes more than a mailing list will use: 10 million requests, 1 million
queue operations (about 330,000 emails, at roughly three operations each), 50 million
database writes and 5 GB of database a month.

### 📐 What that looks like for real lists

| Your list | Mail a month (weekly newsletter, plus sequences) | Cloudflare | Resend | Total |
|---|---|---|---|---|
| 500 people | ~2,500 | $5 | $20 (the free tier's 100 a day can't fit one broadcast) | **~$25** |
| 5,000 people | ~22,000 | $5 | $20 | **~$25** |
| 15,000 people | ~65,000 | $5 | $20 + ~$14 overage | **~$39** |

### 🪙 Getting it cheaper

The biggest cost is Resend, and it's replaceable. Kōlea's mail provider is one adapter
file (see [Make it yours](CONFIG.md#-make-it-yours)). **Amazon SES** charges $0.10 per 1,000
emails, so a 500-person list would cost about 5 cents a broadcast and the whole setup
would run for about $5 a month. **There is no SES adapter yet.** It's the next thing
worth building for small lists. A "small list" mode that fits the free Workers plan's
limits would be a larger change to how sending works, and it isn't planned.

<sub>Prices as published by each provider in September 2026. Check their pricing pages
before you rely on a number here.</sub>

---

[Back to the README](../README.md)
