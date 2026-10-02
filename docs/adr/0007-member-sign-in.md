# ADR 0007 — Members sign in with an emailed link; an account links to a person only when that is certain

- Status: accepted
- Date: 2026-10-02

## Context

Groups, the feed, events and prayer all need to know which member is acting. Members are not Twenty users:
staff sign in to Twenty, members use the portal (plan, "Identity"). Members should not need a password, and a
church's records are messy: families share an address, a child's record often carries a parent's address, and
people are entered twice. Sign-in must never tell a stranger who belongs to a church, and must never merge people.

## Decision

**An emailed, single-use link.**

- `POST /v1/auth/sign-in` (or the `/sign-in` page) queues a `mail.signInLink` job.
  - It answers the same for every well-formed address, known or not.
  - The worker, not the request, decides whether a link is sent. A link goes only to an address an adult in the
    church's records uses (`mayReceiveSignInLink`). Deleted and deceased people and accounts that staff disabled
    get nothing.
  - So the form cannot be used to learn who belongs, or to send mail to strangers.
- A link works once, within 15 minutes, and only under its own church's host: row-level security keeps the
  church's links to itself. Only a SHA-256 of the token is stored.
- Opening the link shows a **Continue** button. The link is used only when the button is pressed, so mail
  scanners that open links do not use them up.
- Limits:
  - 3 links per address per 15 minutes, whoever asks;
  - 10 requests per client IP per 10 minutes (`FOLD_SIGNIN_RATE_LIMIT`).

**A session cookie.**

- The session token is random and only its hash is stored (`portal_session`, migration 0005). It lasts 30 days
  and is revoked on sign-out.
- The cookie is HttpOnly and `SameSite=Lax`. When `FOLD_PUBLIC_URL` is https it is also `Secure` and carries the
  `__Host-` prefix.
- The session is checked against the database on every request, so a disabled account or a deleted person takes
  effect at once.
- Every state-changing request that carries an `Origin` header must come from the same host. Together with
  `SameSite=Lax`, that stops other sites from posting on a member's behalf.

**Linking an account to a person** (`decidePortalLink` in `packages/core`, with property tests):

- The account is linked automatically (`VERIFIED`, method `magic_link`) only when exactly one adult in the records
  uses the address and staff have not marked it as a shared family address. Proving control of an address that
  the church recorded for exactly that adult is enough.
- Anything less certain leaves the account signed in but `UNCONFIRMED`, and it sees no member content:
  - two adults on one address;
  - a shared family address;
  - an address used only by a child.
  A person at the church confirms these.
- An existing link, including one staff rejected, is never re-decided at sign-in.
- Children never get accounts. Nothing is ever merged.

**Email** goes out by SMTP from community-api, through nodemailer (MIT-0, no dependencies). It is plain text,
with no tracking, and says plainly that it was sent automatically. It never goes through Twenty. In development
every message lands in Mailpit.

**Pages.** Until the portal app exists, community-api serves four plain pages: sign in, check your email,
continue, and signed in. They need no JavaScript. The JSON endpoints (`/v1/auth/*`, `/v1/me`) are what the
portal will use.

## Consequences

- Sign-in works only once the church's people are in `person_read`. They get there through the connection card's
  write-through, webhooks, or the hourly reconcile. Like every outbox job, sign-in email is sent only while the
  church's Twenty key is configured.
- **Not built yet:**
  - **staff confirmation** of `UNCONFIRMED` accounts. Until it exists, a shared-address household cannot use
    member features. This is the next piece, together with groups.
  - **passkeys** (the `passkey_credential` table exists).
- The per-IP limit is held in each API process's memory. With several API replicas, each enforces its own.
- Production email needs a real relay, plus SPF and DKIM for the sending domain. That is not handled here.
