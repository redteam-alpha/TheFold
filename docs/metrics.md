# Metrics

The Fold measures **the church's follow-through**, never individual people. No metric is shown per
person to anyone but that person's own shepherd, and none is a ranking.

| Metric | Definition |
|---|---|
| Guests personally contacted in 48h | % of first-time guests with a `firstActionAt` within 48h of first visit; also the median time |
| Time to first group | % attending a group or event within 30 days; median days to first group |
| Care follow-through | Care-request closure rate; median time to first response; % of promised check-ins done on time |
| Re-engagement after a check-in | % engaging again within 30 days. "They're fine, no return needed" is a valid, successful outcome |
| Shepherd load | Open items per shepherd (the cap is a safety valve, not a target) |
| Notification opt-out rate | A health signal for our own hygiene |
| Guest pulse | One question: "Did someone know your name?" |

Computed nightly by community-api into `metric_snapshot` (Twenty dashboards cannot compute medians —
UNVERIFIED). 48h is a design target, not proven science (see research notes).
