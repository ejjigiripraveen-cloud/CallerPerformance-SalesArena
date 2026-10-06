#!/usr/bin/env bash
# Parse-only Apex check (no org needed): fails on syntax errors, ignores style.
set -u; rc=0
for f in "$@"; do
  if ! npx prettier --plugin=prettier-plugin-apex "$f" > /dev/null 2> /tmp/apexparse.err; then
    echo "PARSE ERROR: $f"; head -5 /tmp/apexparse.err; rc=1
  fi
done
[ $rc -eq 0 ] && echo "apex parse OK ($# files)"; exit $rc
