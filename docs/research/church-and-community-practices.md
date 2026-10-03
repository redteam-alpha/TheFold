# What has worked: church management systems, community platforms, CRM playbooks

Research date: 2026-09-30. **Access caveat:** most primary sites (Pew, Lifeway, Planning Center,
Rock community, Rainer, Nextdoor) were blocked from the research environment, so figures below come
from search-result summaries of the cited pages, not full-page reads. **Re-check any number before
publishing it.**

Tags: **[V]** vendor/marketing · **[I]** independent or peer-reviewed · **[J]** journalism/secondary ·
**[C]** correlational / self-reported.

## A. Church management systems

| System | What stands out |
|---|---|
| **Planning Center** | Lists refresh nightly and drop matching people into workflows, e.g. first-time kids check-in → "First Time Guest" workflow on Monday; steps can auto-snooze ([blog, Jan 2024](https://www.planningcenter.com/blog/2024/01/build-your-to-do-list-automatically-create-new-tasks-with-automations)) [V]. Groups: attendance reminders for leaders, lowest-attendance people at the top of the report, group finder and chat ([Groups](https://www.planningcenter.com/groups)) [V]. Services: volunteers set block-out dates and accept/decline; declines auto-reschedule ([2024](https://www.planningcenter.com/blog/2024/09/auto-reschedule-declined-volunteer-requests-in-services)) [V]. People is free; other modules ~$15–$239/month on a usage ladder ([third party, 2026](https://churchmemberpro.com/blog/planning-center-pricing-guide/)) [J]. Complaints: learning curve, duplicate profiles across products, weak reporting ([G2](https://www.g2.com/products/planning-center-people/reviews)) [I, unverified sample]. |
| **Breeze (Tithe.ly)** | Flexible tags plus **Follow Ups** — a task assigned to a person about a specific individual. Praised for simplicity and support ([Capterra](https://capterra.com/p/132513/Breeze-ChMS/reviews/)); outgrown for reporting and automation. |
| **Church Community Builder / Pushpay** | **Process queues**: step-by-step follow-up sequences with an owner per step ([overview](https://pastorsline.com/ccb-process-queues/)) [V]. Reported enterprise pricing and worse support after the Pushpay acquisition ([G2 compare](https://www.g2.com/compare/yourgiving-inc-breeze-chms-vs-church-community-builder)) [J]. |
| **Rock RMS** | Free under the Rock Community License for 501(c)(3)s (source-available, **not** OSI open source); ASP.NET on SQL Server ([GitHub](https://github.com/SparkDevNetwork/Rock)). Connections model: requests, statuses, activities, workflows ([docs](https://rockrms.dev/Rock/Book/30)); families are a first-class group type; people carry custom attributes and timeline history. Details beyond search summaries UNVERIFIED. |
| Others | Tithe.ly bought Elvanto (2023); Subsplash is app-first and premium-priced; Realm draws UI complaints ([roundup](https://theleadpastor.com/tools/best-church-management-software/)) [J]. Fellowship One and Ministry Platform were **not researched** (UNVERIFIED). |

**Pattern.** Every serious ChMS converges on one loop: *person → list rule → workflow → named owner →
due date → snooze.* What is missing across these tools is a person-centred view of care. That is the
gap The Fold targets.

## B. Social and community platforms

**Healthy mechanics**

- **Verification.** Nextdoor verifies by postcard, phone, card charge or neighbour-leader ([explainer](https://www.orgpvashop.com/how-to-confirm-account-on-nextdoor/)) [J]. It reports ~300,000 volunteer moderators and ~90% of reports human-reviewed within 6 hours ([2025 Transparency Report](https://about.nextdoor.com/press-releases/nextdoor-publishes-2025-transparency-report)) [V].
- **Friction at the right moment.** Nextdoor's Kindness Reminder: about a third of flagged replies were rewritten; the company claims a 75% drop in racial profiling ([summary](https://uk.finance.yahoo.com/news/how-a-small-design-tweak-cut-racial-profiling-on-nextdoor-by-75-070000670.html)) [V].
- **Admin tooling.** Facebook Groups: membership questions, rule agreement, Admin Assist, member summaries ([Meta, 2022](https://about.fb.com/news/2022/03/new-tools-for-facebook-group-admins/)) [V].
- **Events + reminders.** Automated reminders cut no-shows ~34%; free events ~28% no-shows vs 17% paid ([benchmarks](https://www.nunify.com/blogs/event-attendance-rate)) [V, low quality].
- **Onboarding.** Departures within 30 days point to an onboarding failure ([Heartbeat](https://www.heartbeat.chat/article/why-most-online-communities-fail)) [V].

**What backfires**

- **Engagement-ranked feeds.** Facebook's 2018 "meaningful interactions" change reportedly made the platform angrier and more polarised ([NBC](https://www.nbcnews.com/tech/social-media/facebooks-2018-algorithm-change-boosted-local-gop-groups-research-find-rcna27503)) [J].
- **Moderator burnout.** Volunteer moderators quit over burnout, conflict and toxic exposure ([Schöpke-Gonzalez et al., 2024](https://journals.sagepub.com/eprint/BBWM7VPP9JCWFWFZMIZY/full)) [I].
- **Notification overload.** One weekly push makes ~10% of users disable notifications; 3–6 pushes push ~40% to say "no more" ([Braze](https://www.braze.com/resources/articles/opt-out-of-push-notifications-why-users-do-it)) [V, directional].
- **Unsafe defaults for minors.** New Jersey's attorney general sued Discord (April 2025) over default DM settings and weak age verification ([summary](https://www.pritzkerlaw.com/child-safety-lawyer/social-media-harm-addiction-lawsuits/how-discord-can-harm-kids-and-teens-what-parents-can-do-and-when-a-lawsuit-may-be-warranted/)) [J, law-firm marketing; allegations only].
- **Taxing organisers.** Meetup's 2024 price rises and per-RSVP fees drove organisers away ([Piper](https://andypiper.co.uk/2024/10/18/meetup-com-is-so-over/)) [J, anecdotal].

**Gaps.** No independent retention data found for Hallow, Glorify, YouVersion groups or Bonfire
(UNVERIFIED). Mighty Networks' "59% weekly return" is marketing [V]. "Groups of 9–15 split into
active/less-active" comes from a blog citing Dunbar-style work (UNVERIFIED).

## C. CRM and retention playbooks

- **Salesforce Nonprofit Success Pack.** Engagement Plan Templates hold tasks with timing, dependencies and assignees, applied to a Contact, Household or Campaign ([Salesforce Help](https://help.salesforce.com/s/articleView?language=en_US&id=sfdo.npsp_create_and_manage_engagement_plans.htm&type=5)). The best-documented "next best action" pattern.
- **Bloomerang.** Each donor is cold/warm/hot/on-fire from giving, communications, events and volunteering ([Bloomerang](https://bloomerang.com/nonprofit-glossary/donor-retention)) [V]. First-time donor retention is 18.9% (Q4 2025, Fundraising Effectiveness Project; [summary](https://signalandnoises.org/2026/03/01/nonprofit-donor-retention-statistics-2026/)) [J].
- **Health-score critiques.** Static thresholds produce false positives; trend against a person's *own* baseline predicts better than absolute counts; the commonest failure is that staff stop trusting the score ([Routine](https://routine.co/blog/posts/build-customer-health-score)) [V, consistent across sources].
- **What generalises.** Task templates, named owners and baseline-relative "drift" prompts. **What does not:** composite scores, giving-weighted scoring, automated "risk" labels on people.

## D. Church research (with evidence quality)

- **Follow-up timing.** "85% return if contacted within 36 hours" and "75% more likely if called within 48 hours" circulate through vendor and blog pages; **the primary study could not be traced — UNVERIFIED folklore** ([example](https://getvisiconnect.com/blog/why-churches-lose-80-percent-of-visitors.html)) [V]. We use 48h as a *design target*, not a proven number.
- **The follow-up gap.** Faith Perceptions surveyed 1,321 first-time visitors (2015–16). Of the 504 who gave contact details, only **24% (119) had any follow-up after 30 days** ([summary](https://www.semissourian.com/features/faith-perceptions-analyzes-the-church-experience-1875636)). Commercial mystery-guest vendor, but a real sample.
- **What brings guests back.** Friendliness alone does not, but an unwelcoming encounter sends people away; prompt follow-up matters alongside the message ([Lifeway/Faith Perceptions, 2018](https://research.lifeway.com/2018/08/30/5-things-that-matter-most-to-church-visitors/)) [C].
- **Friendship and retention.** 59% of those who stayed connected have a close friend in the church vs 31% of those no longer active ([Barna](https://www.barna.com/trends/fostering-relationships-at-church/)) [C].
- **Small groups and discipleship.** Discipleship scores 74.1 (5+ times a month) vs 60.4 (no groups); 2,130 Protestant churchgoers, March 2025 ([Lifeway, 2026-08-04](https://research.lifeway.com/2026/08/04/small-group-participation-linked-to-higher-discipleship-scores/)) [C, self-report].
- **Predictors of growth.** Evangelism, assimilation, small-group discipleship and church size, in a 1,000-pastor phone survey ([Lifeway, 2023](https://research.lifeway.com/2023/03/22/4-factors-that-predict-church-growth/)) [C].
- **Dropouts.** 59% of formerly churched adults cited life-situation changes and 37% disenchantment; n=469, 2006 — old ([Lifeway](https://research.lifeway.com/2006/10/26/some-losses-inevitable-but-churches-can-guard-the-back-door/)) [C].
- **Lapse thresholds.** The typical churched adult attends ~1.6 times a month; "regular" now often means every 4–6 weeks ([Barna](https://www.barna.com/research/young-adults-lead-resurgence-in-church-attendance/)) [I]. A blanket "missed 3–4 weeks" rule would flag most regulars. Vendors default to ~3 weeks; **no validation of that number found.**

## E. Risks

- **Religion as sensitive data.** GDPR Art. 9 treats religious belief as a special category; Art. 9(2)(d) lets religious not-for-profits process members' data internally without consent, but external sharing needs explicit consent ([Art. 9](https://gdpr-info.eu/art-9-gdpr/)). CCPA generally excludes nonprofits, but for-profit vendors are not excluded ([overview](https://www.truevault.com/learn/does-ccpa-apply-to-nonprofits)) [J]. Whether The Fold's own entity is covered: UNVERIFIED, needs counsel.
- **Children.** Amended COPPA rule effective 2025-06-23, compliance due 2026-04-22; requires a written retention policy and separate consent for third-party disclosure ([Federal Register](https://www.federalregister.gov/documents/2025/04/22/2025-05904/childrens-online-privacy-protection-rule)) [I].
- **Background checks.** Checks through a consumer reporting agency fall under the FCRA, including adverse-action process ([guide](https://www.protectmyministry.com/blog/a-guide-to-background-checks-when-working-with-children/)) [V]. We store only status and date.
- **Permissions.** Vendor white papers say many ChMS tools use flat permissions, shared admin logins and no audit trail, exposing prayer requests and care notes ([Kinship](https://usekinship.com/whitepapers/church-data-privacy)) [V].
- **Scoring people.** Gloo drew scrutiny for data-driven targeting that reportedly included mental-health and addiction signals ([Christian Post](https://www.christianpost.com/news/churches-using-big-data-to-target-new-members.html)) [J, secondary].
- **AGPL.** Twenty is AGPL-3.0; get a legal read on network-service obligations (UNVERIFIED).

## F. Synthesis: what The Fold builds, and what it refuses to

**MVP principles (each backed above)**

1. One **named welcomer** per guest, due in 48h — the 24% follow-up gap; owner-per-step designs in Breeze/CCB.
2. **Digital connection card (QR)** with consent and interests.
3. A **human-first guest sequence** (call/text → invite → group intro) with snooze — Planning Center First Time Guest, NPSP engagement plans.
4. **Promises and care requests as tasks**: single owner, due date, status, overdue queue — Rock connection requests, CCB queues.
5. **Household model with dedupe** at sign-up; never auto-merge — Planning Center's duplicates are a top complaint.
6. **Group directory + leader view** of who needs a follow-up.
7. **Interest and season matching with a human warm intro** — Barna friendship gap (59% vs 31%).
8. **Events as the anchor**, with RSVP, reminders, post-event nudge.
9. **Leader-approved or invite-verified membership** tied to the CRM record — Nextdoor/Facebook.
10. **Tiered visibility for prayer and care**, auto-expiry, audit log.
11. **Drift prompts against a person's own baseline**, with snooze and "they're fine" — Barna's 1.6/month, health-score critiques.
12. **Digest-by-default notifications**, per-category controls, quiet hours — Braze data (directional).
13. **Light moderation kit**: rules, approval queue, kindness nudge, rotating moderators.
14. **Minor-safe by default**: no adult-to-minor DMs, parent-managed minors, retention policy.
15. **Serving pathway** with accept/decline/block-out — Planning Center Services (post-MVP).

**Do NOT build:** attendance leaderboards/streaks/rankings · giving-weighted engagement scores ·
peer-visible "who's missing" lists · ranked or infinite feeds and vanity counters · auto-sent "we
missed you" messages posing as personal · third-party data enrichment or lookalike targeting · open
member search exposing minors · any individual "risk" grade shown outside the care team.

**Metrics that keep people at the centre** (measure the church's follow-through, never rank individuals):
% of first-time guests personally contacted within 48h and median time · % attending a group or event
within 30 days and median time-to-first-group · care-request closure rate, median time-to-first-response
and % of promised check-ins on time · re-engagement within 30 days of a check-in (counting "they're
fine, no return" as valid) · open items per shepherd · notification opt-out rate · a one-question guest
pulse: *"Did someone know your name?"*
