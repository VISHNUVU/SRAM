# PipelineHQ — multi-tenant SaaS sales CRM

A complete sales CRM for teams. It's Node ≥ 22.13 with built-in SQLite (`node:sqlite`). The only dependency is `@anthropic-ai/sdk`, for the AI features.

```bash
npm install
npm start                                   # http://localhost:3000
npm run seed -- http://localhost:3000       # demo workspace: demo@pipelinehq.test / demo12345
npm test                                    # 32 end-to-end API tests
npm run backup                              # consistent (optionally encrypted) DB backup
```

Configuration is in [`.env.example`](.env.example). Every integration is optional: if it isn't configured, the app falls back to a working local behaviour, and Settings → API & integrations shows each one's status.

## Features

| Area | What's included |
|---|---|
| **Core records** | Contacts, companies, deals, tasks/calls/meetings/notes. **Activity timeline** on every record (activities, emails, stage changes, field edits). **Custom fields** (text, number, date, dropdown, checkbox, URL, email; can be required). **CSV import** with column mapping and skip/update/duplicate modes. **CSV export**. **Duplicate detection** (on create, plus a duplicates report) with **merge**. Global search (`/`). File attachments. |
| **Pipeline** | **Multiple pipelines**, each with its own stages, win probabilities and won/lost kinds. Drag-and-drop board, lost reasons, stage history. List view with filters, sorting, **saved views** (personal or shared) and **bulk actions** (assign, move stage, set lifecycle, enrol in a sequence, delete). |
| **Email** | **Gmail** OAuth: send from the rep's own mailbox, and the inbox auto-syncs to contact timelines. **Resend/Postmark** for transactional sending. A **BCC/forward-to-log address** and an inbound webhook (Postmark/Mailgun style). **Templates** with merge fields. **Open tracking**. **Sequences** (multi-step email + task cadences) that stop automatically when the contact replies or unsubscribes. Unsubscribe links. |
| **Calendar & calls** | Per-user **ICS feed** that you subscribe to from Google/Outlook/Apple. Public **booking pages** that respect time zones, block conflicts and send confirmations. **Click-to-call**: `tel:` links, or Twilio bridging. Call logging with outcomes. |
| **Lead capture** | Hosted / iframe / plain-HTML **web-to-lead forms** with a honeypot. **Round-robin** or fixed assignment. Auto-enrolment in a sequence. **Rule-based lead scoring** on fields, business email, opens, replies and meetings. |
| **Notifications** | In-app notification bell plus email for assignments, replies, opened emails, overdue tasks, meetings about to start, **stalled deals**, accepted quotes and booked meetings. |
| **Forecasting & reports** | Monthly **forecast** (won / commit / weighted / best case vs quota). **Quotas** per rep and attainment. **Reports**: conversion funnel, win rate, sales cycle, average deal, lost reasons, leads by source, leaderboard, activity, email open rate, 12-month revenue. |
| **Team & permissions** | Roles **owner / admin / manager / rep**. A **reporting hierarchy** controls visibility (reps see their own records, managers see their team's). Deactivating a user reassigns their records. **Audit log** of every change, including impersonation. |
| **Quotes** | **Products**, **price books**, line items with discounts and tax. The customer gets a public quote page with **typed-name e-signature** (name, timestamp and IP are recorded) and print-to-PDF. Accepting a quote fires the `quote.accepted` automation trigger. |
| **Automation** | Workflows: **trigger + conditions + actions**. 12 triggers (deal won/lost/stage changed, lead created, reply received, quote accepted…). Actions: create task, notify, send template, update field, enrol in sequence, round-robin, webhook, **Slack**. |
| **AI (Claude)** | Draft emails from the record's history. Summarise a deal/contact/company with risk and next steps. Clean up call notes. **Company enrichment** from the website (works without AI too, using meta tags). |
| **SaaS platform** | Self-serve signup with a 14-day Pro trial. **Stripe** per-seat Checkout, Customer Portal and signed webhooks. Free/Pro **plan limits** (seats, contacts, pipelines, Pro-only features). **Email invites**, **password reset**, **Google SSO**, **TOTP 2FA**. **REST API** with API keys. **Signed outbound webhooks** with retries. **Super-admin console**: platform metrics, plan overrides and **impersonation**. |
| **Security & compliance** | scrypt passwords. HttpOnly SameSite cookies (optionally `Secure` + HSTS). CSRF origin checks. A strict CSP on every page. Per-IP rate limits and login throttling. Tenant isolation on every query. Cross-tenant reference checks. SSRF-guarded outbound fetches. Secrets encrypted at rest (AES-GCM). CSV-injection-safe exports. **GDPR**: full JSON export, per-contact erasure, workspace deletion. **Encrypted backups** (`npm run backup`). |
| **Mobile** | Responsive down to phone width, with an off-canvas nav and a scrollable board. Installable PWA manifest. |

## Architecture

```
server.js            HTTP server, static SPA, error handling
lib/db.js            SQLite schema + versioned migrations
lib/http.js          router, auth (session cookie | Bearer API key), CSRF, rate limits
lib/core.js          visibility scope, audit, notifications, events, custom fields, scoring, timeline
lib/workflows.js     automation engine        lib/sequences.js   cadences
lib/email.js         send queue + providers   lib/inbound.js     reply logging
lib/google.js        OAuth, Gmail send/sync   lib/stripe.js      billing
lib/twilio.js        click-to-call            lib/ai.js          Claude features
lib/worker.js        DB-backed job queue + periodic jobs (sequences, reminders, stalled deals, Gmail sync, cleanup)
routes/              auth · records · sales · admin · public (forms, booking, quotes, tracking, ICS, webhooks)
public/              vanilla-JS SPA (core · records · sales · settings)
```

### REST API

Create a key under Settings → API & integrations, then send it as a Bearer token. Every endpoint the UI uses is available, for example:

```bash
curl -H "Authorization: Bearer crm_..." "https://crm.example.com/api/deals?status=open&pipeline_id=1"
```

Outbound webhooks are signed with `X-PipelineHQ-Signature: sha256=HMAC_SHA256(secret, rawBody)`.

## Before production

- Serve the app over HTTPS. Set `APP_URL`, `COOKIE_SECURE=1`, `APP_SECRET`, and `TRUST_PROXY=1` if it runs behind a proxy.
- Configure a mail provider (Resend/Postmark) and SPF/DKIM for your sending domain. Point an inbound-parse route at `/api/inbound/<token>`.
- Set up Stripe: create a per-seat recurring price, set `STRIPE_*`, and add the webhook (`checkout.session.completed`, `customer.subscription.*`).
- Schedule `npm run backup`, for example nightly via cron, and also back up `DATA_DIR/files`.
- **Scaling:** this runs as a single process with SQLite in WAL mode, which comfortably serves hundreds of small teams. To run multiple instances you'd need to move to Postgres, a shared job queue, Redis rate limiting, and S3 for files.
- **Not code:** SOC 2 and similar certifications are organisational processes (policies, audits, vendor reviews), not something the app can provide by itself.
