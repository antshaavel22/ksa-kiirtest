# CLAUDE.md — ksa-kiirtest

Guidance for Claude Code working in this repository, and the guardrail for marketing
editors (Silvia, Jana) who change this site by describing the change to an assistant
that has the repo open. There is no visual editor here. **This file is the guardrail.**

## What this is

The KSA eye-test funnel at **kiirtest.ksa.ee**. A visitor answers a short quiz, the quiz
decides which service fits, and the result page hands them a discount code and a booking
link. It is the top of the Flow3 funnel, so a broken quiz is lost revenue the same day.

Plain static HTML with inline CSS and JS — no framework, no build step. Serverless
functions in `api/` handle tracking, the CRM ticket, Slack alerts, Brevo and the Google
Ads conversion upload.

| File | What it is |
|---|---|
| `index.html` / `en.html` / `ru.html` | the quiz, one per language |
| `taname*.html` | thank-you pages |
| `19.html` | legacy 19 € landing page, served at `/19` and `/broneeri-19` |
| `lilia-qr.html` | QR landing page for Lilia's printed material |
| `uus.html` | v3 draft, not linked from anywhere |
| `api/track.js` | lead → Slack, CRM, Resend, Brevo |
| `api/booking-completed.js` | booking webhook → cancels follow-ups, uploads the Google Ads conversion |
| `vercel.json` | the pretty URLs (`/19`, `/en`, `/ru`, `/lilia`) and CSP |

## Branches and deploying — read this before anything else

- **`kiirtest-v3` is live.** It is the repository default branch. Work from it.
- **`master` is from June 2026 and four months stale.** Do not branch from it, do not merge
  it, do not deploy it. It exists only as history.
- **A push does not deploy.** Vercel's git integration still points at an old, abandoned
  repository (`ksa-kiirtest-lp`, untouched since April). Until Ants reconnects it, the only
  thing that reaches kiirtest.ksa.ee is `vercel --prod` run by Ants or his assistant.
- So: push your branch, say what changed, and ask for it to be deployed. Never assume your
  change is live because the push succeeded — check the live URL.
- After any deploy, verify with `curl` against `https://kiirtest.ksa.ee/`, not against the
  deployment URL (those are behind Vercel's deployment protection and answer 401).

## Never change these without Ants

**The eligibility rule.** `computeRoute()` in each quiz file decides who is offered Flow3:

```js
if (young && isMyope && !tooHigh) return 'flow3';
```

That is a clinical rule — 18–45, confirmed myopia, not above −9 — and it sits ten lines
above the marketing copy in the same script block. Editing text near it is fine. Editing it
is not. The same rule is mirrored server-side in `mapAgeBand()` and `deriveGroupHint()` in
`api/track.js`; the two must agree.

**Discount codes and prices.** The `BOOKING` object holds the code, the price and the
struck-through old price for each route. Codes only work if Mai has created them in the CRM
with the right amount against the right service, so changing a number here without her
changing it there promises a price we will not honour. Ask, never edit.

**Anything in `api/`.** Tokens, the CRM contract, the Google Ads conversion action, the
Slack webhooks. A mistake here is silent: leads keep arriving and stop being recorded.

**Anything that changes a URL** — `vercel.json` rewrites included. Printed QR codes and ad
campaigns point at these paths.

## What editors may change freely

Question wording, answer labels, result text, headlines, CTA wording, the trust strip,
images. In practice that is the HTML between the `<style>` and `<script>` blocks, plus the
`RESULTS` object, which is pure copy.

## Rules the assistant applies without being asked

- **Mobile first.** 80 % of this traffic is a phone. Check the narrowest layout first; tap
  targets at least 44 px.
- **Flow3 is only for 18–45 confirmed myopes.** Never widen that in copy, never imply
  someone outside it will qualify.
- **Tier names from 12.10.2026:** Flow3 Solo (2 490 €), Flow3 (2 990 €), Flow Signature Line
  (5 990 €). Never "Flow 1" — a number after Flow means a technology generation.
- **Never name "Claude" or any AI** in anything a patient reads. Never write "aus / honest /
  честно".
- **Russian:** Таллинн with two н. Jana reviews all new Russian wording.
- **English** has no human editor — keep it plain, no superlatives.
- Booking links point at `https://booking.ksa.ee`, never my.ksa.ee, and keep the attribution
  parameters the page already adds.
- The three quiz files are separate copies of the same page. A change to one almost always
  belongs in all three — say so if you only did one.

## Before handing back

Open the changed page in a browser and walk the quiz to the result, on a phone-width
viewport. There are no tests here; walking the funnel is the test. Then say in one sentence
what changed and what still needs deploying.
