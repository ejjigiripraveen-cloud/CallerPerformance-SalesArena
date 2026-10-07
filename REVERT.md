# Sandbox original: Caller Performance (snapshot 2026-10-07)

This branch holds the code that was live in the prodreplic sandbox before the
zone TV wall was deployed. Tag: `caller-perf-sandbox-original`.
The local code before any refactoring is tagged `caller-perf-local-original`.

Revert the sandbox (validate first, then drop --dry-run):

```bash
sf project deploy start -o Sandbox -x manifest/package.xml \
  --post-destructive-changes manifest/destructiveChangesPost.xml \
  --test-level RunSpecifiedTests --tests GSquareSalesArenaControllerTest \
  --tests GSquareSalesArenaServiceTest --tests GSquareSalesArenaWrapperTest --dry-run
```

Before deleting: unschedule the GSquareArenaBaselineJob job and unassign the
GSquare_Arena_TV permission set, or the deletes fail.
