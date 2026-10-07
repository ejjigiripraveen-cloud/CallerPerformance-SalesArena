# G Square Sales Arena: zone TV wall

One TV per zone. Each screen has a fixed hero band (today and month-to-date pace for Allocation, SV Conducted and Booking), a 3-minute scene cycle (top boards, bottom boards from 12 pm, TL table, Watchlist, managers and heads), a zone race strip, and a full-screen celebration for every booking.

Design spec: https://claude.ai/code/artifact/ddeec28e-e566-4425-8894-dd723d9d1fb1
Implementation plan: `docs/superpowers/plans/2026-10-06-zone-tv-wall.md`

## What is in this project

| Path | Purpose |
| --- | --- |
| `lwc/gsquareSalesArenaWallTV_V2` | The TV page: data, timers, booking subscription |
| `lwc/gsquareArenaLogic` | Every rule (pace, playlist, boards, Watchlist, TV ops), Jest-tested |
| `lwc/gsquareArenaHero`, `Board`, `TeamTable`, `Watchlist`, `Takeover`, `ZoneRace` | Presentational pieces |
| `classes/GSquareSalesArenaServiceWallTV_V2` | Zone payload: today + MTD, zone race, baseline, photos |
| `classes/GSquareArenaBaselineJob` | Nightly "typical day" curves into `GSquare_Arena_Baseline__c` |
| `classes/GSquareArenaBookingEvents` + `triggers/GSquareArenaBookingTrigger` | Publishes `GSquare_Arena_Booking__e` |
| `permissionsets/GSquare_Arena_TV` | For the shared TV user |

## Deploy

```bash
sf project deploy start -x manifest/package.xml --test-level RunLocalTests
```

Then, once, in Execute Anonymous:

```apex
GSquareArenaBaselineJob.runAsync(GSquareArenaBaselineJob.istToday());   // today's curves now (8 queued steps)
GSquareArenaBaselineJob.scheduleNightly();                               // 01:30 every night
```

The cron runs in the org's timezone. If the org is not on IST, adjust `GSquareArenaBaselineJob.CRON` so it runs after midnight IST. Pace tiles read "No baseline yet" until the job has run; curves become meaningful once four weeks of the same weekday exist.

## Shared TV user checklist

- [ ] Time zone set to **Asia/Kolkata**. "Today" and "this month" use this user's timezone.
- [ ] Permission set **G Square Arena TV** assigned.
- [ ] Read access to Lead, `Site_Visit__c`, Opportunity and `Call_Detail__c` and every field the metrics use. A missing field silently drops that metric; check the debug log for `[Sales Arena]` warnings.
- [ ] Read access to the profile-photo files (`User.Profile_Photo_Document_Id__c`).
- [ ] Session timeout on the profile: 24 hours. The page also reloads itself at 08:30 IST and on an expired session.
- [ ] Optional: login IP ranges limited to the office network.

## One Lightning App Page per zone

1. Create an App Page with a one-region layout, add **G Square Sales Arena**, and set **Zone** to the exact `User.Zone__c` value.
2. Open it on the TV in a full-screen (kiosk) browser, Chrome 105 or newer. Text sizes use container units.

## Settings worth knowing

| Setting | Where | Value |
| --- | --- | --- |
| Bottom boards and Watchlist start | `gsquareArenaLogic` `BOTTOM_BOARDS_FROM_HOUR` | 12 |
| Office hours (screen dims outside) | `OFFICE_START_HOUR` / `OFFICE_END_HOUR` | 9 / 20 IST |
| Daily reload | `DAILY_RELOAD` | 08:30 IST |
| Stale warning | `STALE_AMBER_MIN` / `STALE_RED_MIN` | 6 / 10 min |
| Project name on the booking celebration | `GSquareArenaBookingEvents.PROJECT_FIELD` | not set yet |
| Bottom-board eligibility | `isEligible` | `Availability__c` true, 45+ days tenure, Presales outbound |

## Local checks

```bash
npm install
npm run test:unit                                 # LWC Jest suite
scripts/apex-parse-check.sh force-app/main/default/classes/*.cls   # Apex syntax only
```
