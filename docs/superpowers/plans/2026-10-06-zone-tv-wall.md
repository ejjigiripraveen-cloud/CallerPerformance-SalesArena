# Sales Arena Zone TV Wall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `gsquareSalesArena` into a per-zone TV wall: fixed hero band (today + MTD pace), a 3-minute scene cycle, booking takeovers, and unattended-TV resilience.

**Architecture:** A pure-JS module `gsquareArenaLogic` holds every rule (time, pace, playlist, ranking, watchlist, TV ops) and is Jest-tested. Small presentational child LWCs render it; the `gsquareSalesArena` orchestrator owns timers, the wire and the `empApi` subscription. Apex gains a `zone` parameter and always returns today and MTD. A nightly job writes zone- and TL-level baselines to `GSquare_Arena_Baseline__c`, and an Opportunity trigger publishes `GSquare_Arena_Booking__e`.

**Tech Stack:** Salesforce API 66.0, Apex, LWC, `lightning/empApi`, Platform Events, `@salesforce/sfdx-lwc-jest`, `prettier-plugin-apex`.

**Spec:** https://claude.ai/code/artifact/ddeec28e-e566-4425-8894-dd723d9d1fb1 (Sales Arena Zone TV Wall — Design Spec)

## Global Constraints

- `sourceApiVersion` 66.0; all new metadata at 66.0.
- All day/hour logic in IST (`Asia/Kolkata`), never the browser's or org's local clock.
- Screen bands 35 / 55 / 10 of viewport height. Font sizes in `vh` with `clamp()`: hero today `clamp(64px, 11.1vh, 240px)`, MTD `clamp(32px, 4.4vh, 96px)`, row names `clamp(24px, 3.7vh, 80px)`, nothing below `clamp(24px, 2.2vh, 48px)`.
- Refresh every 180 s. Stale: amber at ≥ 6 min since last success, red at ≥ 10 min, red text "Data paused, reconnecting".
- Bottom boards and Watchlist only from 12:00 IST. Booking takeover 10 s, queued, deduped by Opportunity Id, shown on every zone TV.
- No interactive controls anywhere on the wall; no config-warning strip on screen (`console.warn` only).
- Pace tile tone from today only: ratio today/typical ≥ 1.05 good, ≥ 0.95 neutral, ≥ 0.80 warning, else critical; typical missing or 0 → neutral, text "No baseline yet".
- Booking criteria reuse `GSquareSalesArenaWrapper.BOOKING_MIN_RECEIPTS` (90000) and `BOOKING_EXCLUDED_STAGE` ('Cancelled'); caller = `Presales_Owner__c`, else `SV_User__c`.
- Watchlist/bottom-board eligibility: `availability === true && tenureEligible === true && profileName === 'Presales outbound'`. `Availability__c` true = active for the day. Zero performers who are active today DO appear on bottom boards; callers whose `Availability__c` is false or blank never do.
- **Verification limits in this environment:** LWC Jest runs here. Apex can only be parse-checked here (`npx prettier --check --plugin=prettier-plugin-apex <files>`); every Apex task ends with an **Org check** step Jessee runs: `sf project deploy start -x manifest/package.xml --test-level RunSpecifiedTests --tests <TestClass>`.

## Review Focus

1. Zone property blank or naming a zone with no callers → wall shows "Zone not configured" / empty boards, never a blank or a crash (Task 6, Task 9 tests).
2. No baseline rows yet (first deploy, failed nightly run) → hero tiles neutral with "No baseline yet"; TL table shows no pace (Task 1 test).
3. Same booking published twice (Opportunity updated again after qualifying) → one takeover only (Task 4 and Task 7 tests).
4. IST date rollover while the TV runs → rank-movement memory and cycle reset; on the 31st, last-month-to-date caps at last month's length (Task 4, Task 5 tests).
5. `Profile_Photo_Document_Id__c` null or not a ContentDocument URL → initials, no broken image (Task 6, Task 8 tests).

---

### Task 1: Logic module — IST time and pace

**Files:**
- Create: `force-app/main/default/lwc/gsquareArenaLogic/gsquareArenaLogic.js`, `gsquareArenaLogic.js-meta.xml` (`isExposed` false)
- Test: `force-app/main/default/lwc/gsquareArenaLogic/__tests__/time.test.js`, `pace.test.js`

**Interfaces:**
- Produces: `istParts(nowMs: number) → {dateKey:'YYYY-MM-DD', hour:0-23, minute, weekday:1-7 (Mon=1), dayOfMonth, monthLabel:'Oct', prevMonthLabel:'Sep'}`; `typicalByNow(hourly: number[24]|null, ist) → number|null`; `paceState(today: number, typical: number|null) → {tone:'good'|'neutral'|'warning'|'critical', text: string}`; `mtdState(mtd: number, lastMonthToDate: number|null, prevMonthLabel: string) → {tone, text}`.

- [ ] **Step 1: Setup (first task only).** `git init`, commit the unzipped project as `chore: baseline`, `npm install`. Run `npx sfdx-lwc-jest` → "No tests found" exit is acceptable. Run `npx prettier --check --plugin=prettier-plugin-apex "force-app/**/*.cls"` → record whether existing classes parse (formatting diffs are fine; parse errors are not).
- [ ] **Step 2: Write failing tests.**
  - `istParts(Date.UTC(2026,9,6,8,44))` → `{dateKey:'2026-10-06', hour:14, minute:14, weekday:2, dayOfMonth:6, monthLabel:'Oct', prevMonthLabel:'Sep'}`.
  - `istParts(Date.UTC(2026,9,6,18,40))` → `dateKey '2026-10-07', hour 0` (rollover).
  - `typicalByNow(h, {hour:14, minute:30})` where `h[13]=20, h[14]=24` → 22 (linear: previous hour's cumulative + fraction of the step). `hour 0` uses 0 as previous. `null` hourly → `null`.
  - `paceState(64, 58)` → `{tone:'good', text:'+6 vs typical 58'}`; `paceState(18, 22)` → `{tone:'warning', text:'4 behind typical 22'}`; `paceState(2, 2)` → `{tone:'neutral', text:'On pace, typical 2'}`; `paceState(10, 20)` → tone `critical`; `paceState(5, null)` and `paceState(5, 0)` → `{tone:'neutral', text:'No baseline yet'}`. Typical rounds to an integer in text.
  - `mtdState(1412, 1307, 'Sep')` → `{tone:'good', text:'+8% vs Sep'}`; `mtdState(11, 9, 'Sep')` → `'+2 vs Sep'` (absolute when lastMonthToDate < 20); `mtdState(412, 425, 'Sep')` → `'−3% vs Sep'` tone `warning`; `null` → `{tone:'neutral', text:''}`.
- [ ] **Step 3: Run** `npx sfdx-lwc-jest gsquareArenaLogic` → FAIL (module missing).
- [ ] **Step 4: Implement** using `Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata', ...}).formatToParts`. Percent rounds to integer, minus sign U+2212.
- [ ] **Step 5: Run** → PASS. **Commit** `feat(arena): IST time and pace logic`.

### Task 2: Logic module — scene playlist

**Files:** Modify `gsquareArenaLogic.js`; Test `__tests__/playlist.test.js`

**Interfaces:**
- Produces: `buildPlaylist(ist, cycleIndex: number) → Array<{id: string, kind:'top'|'bottom'|'team'|'leaders'|'watchlist', metricKey?: string, seconds: number}>`; `BOARD_METRICS = ['allocation','svScheduled','svConducted','booking','talktime']`.

- [ ] **Step 1: Failing tests.**
  - Before noon (`hour 11`), cycle 0: ids in order `allocation-top, svScheduled-top, svConducted-top, booking-top, talktime-top, team-tl`; tops 30 s, team 25 s; total 175.
  - From noon (`hour 12`), cycle 0: `allocation-top 20, allocation-bottom 10, svScheduled-top 20, svScheduled-bottom 10, svConducted-top 20, svConducted-bottom 10, booking-top 20, talktime-top 20, talktime-bottom 10, team-tl 25, watchlist 15`; total 180; no `booking-bottom`.
  - Odd cycle appends `{id:'team-leaders', kind:'leaders', seconds:20}` last (both before and after noon); even cycles do not.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Commit** `feat(arena): scene playlist with noon rule`.

### Task 3: Logic module — boards, team rows, watchlist, rank movement

**Files:** Modify `gsquareArenaLogic.js`; Test `__tests__/boards.test.js`

**Interfaces:**
- Consumes: payload `person` shape from Task 6: `{id, name, initials, photoUrl, tlId, tlName, managerName, headName, zone, profileName, availability, tenureEligible, metrics:{key:number}, mtdMetrics:{key:number}}`; `tlTeamSizes: {tlId: number}`.
- Produces: `isEligible(person) → boolean`; `topRows(people, key, n=10) → Row[]`; `bottomRows(people, key, n=5) → Row[]` (eligible only, ascending, ties by name); `Row = {rank, id, name, initials, photoUrl, subLabel:'TL <name>', value, movement: number|null}`; `teamRows(people, level:'tl'|'manager'|'head', {tlTeamSizes, tlPace}) → TeamRow[]`, `TeamRow = {id, name, label, allocation, svScheduled, svConducted, booking, talktime, pace: {tone,text}|null}`; `watchlistRows(people, metricDefs, settings) → [{name, initials, photoUrl, reasons, zeros, severity}]` (existing `watchlist()` rules, eligible people only); `applyMovement(rows, prevRanksByKey: Map<string, Map<id, rank>>, boardKey) → rows` (mutates nothing; returns new rows with `movement = prevRank - rank`, `null` when no previous).

- [ ] **Step 1: Failing tests.**
  - `topRows` sorts desc by `metrics[key]`, ties by name, ranks 1..n, caps at 10; people with value 0 still listed.
  - `bottomRows` excludes `availability:false`, `availability:null`, `tenureEligible:false`, and `profileName` other than `'Presales outbound'`; a caller with 0 on the metric and `availability:true` IS included; returns 5 lowest ascending.
  - `teamRows(..., 'tl', {tlTeamSizes:{T1:11}})` for 6 zone callers under T1 → `label 'TL Arun · 6 of 11 callers'`; when team size equals zone count → `'TL Arun'`. Sums each metric across the TL's callers in this payload.
  - `watchlistRows` with `watchlistMinWeak:2, watchlistMaxEntries:8, alertCriticalZeroCount:3` reproduces the current rules (below-average on ≥2 metrics; severity critical at ≥3 zeros; worst first) and never lists an ineligible person.
  - `applyMovement`: previous rank 4 → now 2 gives `movement: 2`; new person gives `null`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** — port `watchlist()` from the current `gsquareSalesArena.js:330-363`, adding the eligibility filter. **Step 4: Run** → PASS. **Commit** `feat(arena): board, team and watchlist logic`.

### Task 4: Logic module — TV operations

**Files:** Modify `gsquareArenaLogic.js`; Test `__tests__/tvops.test.js`

**Interfaces:**
- Produces: `staleState(lastSuccessMs, nowMs) → 'fresh'|'amber'|'red'`; `updatedText(lastSuccessMs, nowMs) → 'Updated just now'|'Updated 4 min ago'|'Data paused, reconnecting'`; `isAuthError(error) → boolean`; `shouldDailyReload(ist, lastReloadDateKey) → boolean` (true once per IST date at or after 08:30); `isDimmed(ist) → boolean` (outside 09:00–20:00 IST); `burnInOffset(nowMs) → {x, y}` (cycles `[0,0],[2,0],[2,2],[0,2]` every 5 min); `TakeoverQueue` class with `push(event) → boolean` (false on duplicate `opportunityId`), `next() → event|null`, `size`.

- [ ] **Step 1: Failing tests.** 5 min → `fresh`; 6 min → `amber`; 10 min → `red` with text `'Data paused, reconnecting'`. `isAuthError({status:401})` and `{body:{message:'Session expired or invalid'}}` → true; `{status:500}` → false. Reload: 08:29 false; 08:30 with last `'2026-10-05'` true; same date again false. Dim: 08:59 true, 09:00 false, 19:59 false, 20:00 true. `TakeoverQueue`: same `opportunityId` twice → second `push` false, size 1.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Commit** `feat(arena): TV-ops logic`.

### Task 5: Apex — baseline object and nightly job

**Files:**
- Create: `objects/GSquare_Arena_Baseline__c/` (object + fields: `Scope_Key__c` Text(120), `Metric_Key__c` Text(40), `Kind__c` Text(10) `'HOURLY'|'MTD'`, `Weekday__c` Number(1,0), `Hour__c` Number(2,0), `Day_Of_Month__c` Number(2,0), `Value__c` Number(10,2), `Unique_Key__c` Text(200) External Id Unique)
- Create: `classes/GSquareArenaBaselineJob.cls` (+ meta), `classes/GSquareArenaBaselineJobTest.cls` (+ meta)

**Interfaces:**
- Produces: `GSquareArenaBaselineJob implements Schedulable`; `public static void computeFor(Date target)` (upserts on `Unique_Key__c`); `public static String scheduleNightly()` (cron `'0 30 1 * * ?'`, name `'GSquare Arena Baseline'`); scope keys `'ZONE:' + zone` and `'TL:' + zone + ':' + tlId`; unique key `scope|metric|kind|weekday-or-day|hour`.
- Metrics: `allocation, svScheduled, svConducted, booking` only, from `GSquareSalesArenaWrapper.getMetrics()` defs (same object/owner/date/status/extra filters).

- [ ] **Step 1: Write tests** in `GSquareArenaBaselineJobTest`: (a) four prior same-weekday dates each with 2 `svConducted` site visits at 10:xx IST for one zone caller → `HOURLY` row for hour 10 and later = 2, hour 9 = 0; (b) TL scope row equals zone row when the TL's callers are all in the zone; (c) target 2026-03-31 → `MTD` row counts February 1–28 only; (d) re-running `computeFor` the same day updates rows, no duplicates. Test data via `@TestSetup` users with `Zone__c`, `ManagerId`, profile `'Presales outbound'`.
- [ ] **Step 2: Parse check** `npx prettier --check --plugin=prettier-plugin-apex force-app/main/default/classes/GSquareArenaBaseline*.cls` → no parse errors.
- [ ] **Step 3: Implement.** Aggregate per metric per date: `GROUP BY ownerField, HOUR_IN_DAY(convertTimezone(dateField))` for date-time fields (Date-only fields → hour 0); map owner → zone/TL from one User query; cumulative hourly sums averaged over the 4 dates; MTD = one aggregate over last month day 1 to `min(target.day(), daysInLastMonth)`.
- [ ] **Step 4: Parse check** → clean. **Org check** `--tests GSquareArenaBaselineJobTest` → all pass. **Commit** `feat(arena): nightly baseline job`.

### Task 6: Apex — zone payload

**Files:**
- Modify: `classes/GSquareSalesArenaController.cls` (`getDashboard`), `classes/GSquareSalesArenaService.cls` (`build`, `loadUsers`, assembly), `classes/GSquareSalesArenaWrapper.cls` (`PersonDTO`, `DashboardDTO`)
- Test: `classes/GSquareSalesArenaServiceTest.cls` (replace the `testcover` body entirely)

**Interfaces:**
- Consumes: `GSquare_Arena_Baseline__c` rows (Task 5).
- Produces: `@AuraEnabled(cacheable=true) getDashboard(String zone)`; `DashboardDTO` adds `zone`, `zoneConfigured: Boolean`, `totals: Map<String,Decimal>` (today), `mtdTotals: Map<String,Decimal>`, `zoneRace: List<ZoneRaceEntry{zone, svConducted}>` (desc, all zones), `baseline: {hourly: Map<metricKey, List<Decimal>(24)>, lastMonthToDate: Map<metricKey, Decimal>, tlHourly: Map<tlId, List<Decimal>(24)> (svConducted only)}`, `tlTeamSizes: Map<Id,Integer>` (all zones). `PersonDTO` adds `initials`, `photoUrl`, `mtdMetrics` (rename of `rangeMetrics`), keeps `profileName`, `availability`, `tenureEligible`. Removes `timezone`, `dateRangeMode` param.

- [ ] **Step 1: Write tests:** blank zone → `zoneConfigured=false`, empty `people`; zone `'Z1'` returns only Z1 callers while `zoneRace` lists Z1 and Z2; `totals` ≠ `mtdTotals` when a prior-day record exists this month; `tlTeamSizes` counts the TL's callers in both zones; photo URL parse: `'https://x.lightning.force.com/lightning/r/ContentDocument/069XXXXXXXXXXXXXXX/view'` → `/sfc/servlet.shepherd/version/renditionDownload?rendition=THUMB240BY180&versionId=<latest>`; null or non-matching → `null`.
- [ ] **Step 2: Parse check** → clean (after Step 3; Apex cannot fail first here — recorded deviation).
- [ ] **Step 3: Implement.** Zone filter in `loadUsers` (`Zone__c = :zone`), always compute both ranges (existing `rangeMetrics` path with `THIS_MONTH`), separate totals, one extra `GROUP BY` for zone race via owner→zone map, baseline read for today's IST weekday and day of month.
- [ ] **Step 4: Parse check; Org check** `--tests GSquareSalesArenaServiceTest`. **Commit** `feat(arena): zone-filtered today+MTD payload`.

### Task 7: Apex — booking platform event

**Files:**
- Create: `objects/GSquare_Arena_Booking__e/` (fields `Opportunity_Id__c` Text(18), `Caller_Id__c` Text(18), `Caller_Name__c` Text(121), `Caller_Initials__c` Text(4), `Photo_Url__c` Text(255), `Tl_Name__c` Text(121), `Zone__c` Text(80), `Project__c` Text(255)); publish behaviour `PublishAfterCommit`
- Create: `triggers/GSquareArenaBookingTrigger.trigger` (Opportunity, after insert, after update), `classes/GSquareArenaBookingEvents.cls`, `classes/GSquareArenaBookingEventsTest.cls`

**Interfaces:**
- Produces: `GSquareArenaBookingEvents.publishNewBookings(List<Opportunity> newList, Map<Id,Opportunity> oldMap)`; `GSquareArenaBookingEvents.PROJECT_FIELD` (String, `null` until Jessee confirms the field; `Project__c` event field left blank when null).
- Qualifies when `Total_Receipts__c >= BOOKING_MIN_RECEIPTS && StageName != BOOKING_EXCLUDED_STAGE && Booking_Date__c == today (IST)` now, and did not qualify in `oldMap` (or insert).

- [ ] **Step 1: Tests:** insert qualifying → 1 event (`Test.getEventBus().deliver()` + count via a test-visible static list); update an already-qualifying record → 0; update crossing the threshold → 1; `StageName='Cancelled'` → 0; caller falls back to `SV_User__c`.
- [ ] **Step 2–4:** Parse check, implement, parse check, **Org check** `--tests GSquareArenaBookingEventsTest`. **Commit** `feat(arena): booking platform event`.

### Task 8: Presentational child LWCs

**Files (each with `.html`, `.js`, `.css`, `.js-meta.xml` `isExposed` false, `__tests__/<name>.test.js`):**
- `lwc/gsquareArenaHero` — `@api clockText, zoneName, dateText, tiles: [{key,label,today,pace:{tone,text},mtd,mtdState:{tone,text}}], updatedText, staleState`
- `lwc/gsquareArenaBoard` — `@api title, progressText, rows: Row[]` (2 columns of 5; photo `<img>` when `photoUrl`, else initials; movement ▲n/▼n)
- `lwc/gsquareArenaTeamTable` — `@api title, rows: TeamRow[]`
- `lwc/gsquareArenaWatchlist` — `@api rows`
- `lwc/gsquareArenaTakeover` — `@api booking: {callerName, initials, photoUrl, tlName, zone, project, todayCountText}`
- `lwc/gsquareArenaZoneRace` — `@api entries: [{zone, svConducted}], currentZone`

- [ ] **Step 1: Failing tests:** hero renders three tiles with `data-tone` attributes from `pace.tone`; board renders 10 rows split 5/5, `img` only when `photoUrl`, movement `▲2` text; team table renders `label`; takeover hides project line when `project` blank; zone race marks `currentZone` with `data-current`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with the Global Constraints sizes; tones map to CSS classes; no buttons. **Step 4: Run** → PASS. **Commit** `feat(arena): presentational TV components`.

### Task 9: Orchestrator — `gsquareSalesArena` rewrite

**Files:**
- Modify (rewrite): `lwc/gsquareSalesArena/gsquareSalesArena.{js,html,css}`, `gsquareSalesArena.js-meta.xml` (add `<property name="zone" type="String" label="Zone" />` for `lightning__AppPage`)
- Test: `lwc/gsquareSalesArena/__tests__/gsquareSalesArena.test.js`

**Interfaces:**
- Consumes: everything above; `getDashboard({zone})`; `lightning/empApi` `subscribe('/event/GSquare_Arena_Booking__e', -1, cb)`, `onError`.
- Produces: nothing downstream.

- [ ] **Step 1: Failing tests** (fake timers, `@salesforce/apex` wire mock, `lightning/empApi` jest mock): blank `zone` → "Zone not configured" text, no wire call; data emitted → hero + first scene of `buildPlaylist`; advancing 30 s before noon moves to scene 2; a booking event renders the takeover for 10 s and the previous scene resumes; a duplicate event is ignored; wire error `{status:401}` calls `window.location.reload`; after 10 min with no success the hero shows `'Data paused, reconnecting'`; no `button` elements in the DOM.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement:** one 1 s `setInterval` driving clock, scene timer, stale check, dim, burn-in and daily reload; `refreshApex` every 180 s; `prevRanks` kept per board and reset on IST date change; config warnings → `console.warn`. **Step 4: Run** full suite → PASS. **Commit** `feat(arena): zone TV orchestrator`.

### Task 10: Coverage padding removal and deployment manifest

**Files:**
- Modify: `GSquareSalesArenaController.cls`, `GSquareSalesArenaService.cls`, `GSquareSalesArenaWrapper.cls` (delete each `testcover()`), `GSquareSalesArenaControllerTest.cls`, `GSquareSalesArenaWrapperTest.cls` (real tests: controller blank zone; wrapper `getMetrics()` returns 7 keys in order), `manifest/package.xml` (add new classes, trigger, objects, LWCs), `README.md` (deploy steps + TV-user checklist from the spec + `GSquareArenaBaselineJob.scheduleNightly()` and a first `computeFor(Date.today())` run)

- [ ] **Step 1:** `grep -c "i++" force-app/main/default/classes/*.cls` → 0 after deletion. **Step 2:** Parse check all classes. **Step 3: Org check** `--test-level RunLocalTests` → all pass, org coverage ≥ 75%. **Commit** `chore(arena): real tests replace coverage padding; deploy manifest`.
