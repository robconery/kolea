# 🎯 PROJECT — Kōlea

> Owner: `/explore`. Do not edit from other phases.

## Problem

Email for Rob's products and newsletter is split across a paid ESP (broadcast) and
whatever the apps do themselves (transactional). The list, the sending, and the
engagement data live in someone else's system, and the ESP bill scales with
subscriber count rather than with use.

**Kōlea is one self-hosted service that handles both broadcast campaigns and
app-triggered transactional email**, with the subscriber list and analytics owned
outright.

Without it: keep paying per-subscriber, keep the list locked in a vendor, and keep
transactional sending as a separate scattered concern.

## Who it's for

- 👤 **Rob only.** Single operator, his own lists and his own apps.
- 🚫 **Not** other customers, not a team, not the public. No signup, no billing, no orgs.

## Goals

- 📤 Send broadcasts to a list and know what happened (opens, clicks, bounces, complaints)
- 🔌 Serve existing apps as the transactional email path (e.g. Big Admin order + download mail)
- 🔁 Run drip / welcome sequences — an ESP replacement is not credible without them
- 🗃 Own the subscriber data, the send history, and the engagement data
- 💸 Cost meaningfully less than the current ESP at Rob's volume

## Success

Primary: **the paid ESP gets cancelled** and all real sending runs through Kōlea.

Supporting signals:
- Deliverability holds — mail lands in inboxes, bounce/complaint rates stay low
- Monthly cost drops vs. current spend
- It's still in weekly use months after launch

## Scope

### ✅ In

- Subscriber list: import, tags/segments, signup + unsubscribe handling
- Broadcast composition and sending
- Transactional send API for Rob's other apps
- Engagement tracking: opens, clicks, bounces, complaints
- Drip / welcome sequences
- Relaying through an existing sending provider

### 🚫 Out

- Visual / drag-and-drop email builder — authoring stays plain (markdown / HTML / templates)
- Multi-tenant SaaS: no signup, billing, orgs, or other customers. Ever.
- Operating own SMTP servers or warming own IPs

## Constraints

- ⏱ No hard deadline — personal-project pace
- 💰 Must run cheap: hosting + sending well under current ESP spend
- 🔗 Must integrate with existing apps (Big Admin order/download email flows are a real consumer)
- 🧱 Stack is already decided — parked for `/design`

## Riskiest unknowns

1. **Deliverability** (top risk). SPF/DKIM/DMARC, sending reputation, spam filtering,
   and provider policy on bulk mail. A self-hosted mailer that lands in spam is worthless
   regardless of how well it's built.
2. Migrating the existing list — subscribers, tags, and engagement history out of the
   current ESP intact.

## Open questions

- ✅ ~~Which ESP is being replaced?~~ → Kit (formerly ConvertKit). Its blanket
   unsubscribe is what drove the scoped-consent model.
- ❓ **List size and monthly send volume?** Drives cost model and scale requirements — TODO
- ✅ ~~Which sending provider relays the mail?~~ → Resend first, behind a swappable port (`/design`)
- ✅ ~~What does "transactional API" mean for Big Admin?~~ → `POST /api/send` with a bearer
   key; Kōlea owns templates, suppression, and logging (`/design`)
- ❓ Does engagement tracking need per-subscriber history, or aggregate per-campaign only? — TODO
- ❓ Is there a compliance floor to hit (CAN-SPAM / GDPR: consent records, unsubscribe SLA)? — TODO
- ✅ ~~Stack details~~ → Cloudflare Workers + D1 + Queues, Hono/JSX, Cloudflare Access (`/design`)
