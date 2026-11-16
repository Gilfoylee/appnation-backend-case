#!/usr/bin/env bash
# Runs the case's verification flow against a running service (default: docker compose on :3000).
# Requires only bash, curl, xargs and standard text tools.
#
#   ./scripts/verify.sh                 # flushes the Redis cache first so "merhaba" starts uncached
#   BASE_URL=http://host:3000 SKIP_CACHE_FLUSH=1 ./scripts/verify.sh
set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
RUN_ID="$(date +%s)-$RANDOM"
FAILURES=0

pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$3', got '$2')"; fi; }

# post <user> <prompt> -> prints "<status> <body>"
post() {
  curl -s -w '\n%{http_code}' -X POST "$BASE_URL/v1/generations" \
    -H "x-user-id: $1" -H 'content-type: application/json' \
    --data "{\"prompt\":\"$2\"}" | { read -r body; read -r status; echo "$status $body"; }
}
status_of() { echo "${1%% *}"; }
cached_of() { echo "$1" | sed -n 's/.*"cached":\([a-z]*\).*/\1/p'; }
remaining() {
  curl -s "$BASE_URL/v1/quota" -H "x-user-id: $1" | sed -n 's/.*"remaining":\([0-9]*\).*/\1/p'
}

if [ "${SKIP_CACHE_FLUSH:-0}" != "1" ]; then
  docker compose exec -T redis redis-cli FLUSHDB >/dev/null 2>&1 && echo "(Redis cache flushed)"
fi

echo "1) merhaba -> 201 cached:false, then MERHABA -> 201 cached:true with unchanged quota"
U1="verify-cache-$RUN_ID"
R=$(post "$U1" "merhaba");  check "merhaba status" "$(status_of "$R")" 201; check "merhaba cached" "$(cached_of "$R")" false
BEFORE=$(remaining "$U1")
R=$(post "$U1" "MERHABA");  check "MERHABA status" "$(status_of "$R")" 201; check "MERHABA cached" "$(cached_of "$R")" true
check "remaining quota unchanged" "$(remaining "$U1")" "$BEFORE"

echo "2) 5 different prompts, the 6th -> 429, then a cached prompt -> 201 cached:true"
U2="verify-quota-$RUN_ID"
for i in 1 2 3 4 5; do
  R=$(post "$U2" "quota prompt $i $RUN_ID"); check "prompt $i status" "$(status_of "$R")" 201
done
R=$(post "$U2" "quota prompt 6 $RUN_ID"); check "6th prompt status" "$(status_of "$R")" 429
check "429 body" "${R#* }" '{"error":"quota_exceeded"}'
R=$(post "$U2" "merhaba"); check "cached prompt after exhaustion" "$(status_of "$R")" 201; check "cached flag" "$(cached_of "$R")" true

echo "3) error deneme -> 502 with unchanged quota"
U3="verify-error-$RUN_ID"
BEFORE=$(remaining "$U3")
R=$(post "$U3" "error deneme"); check "error status" "$(status_of "$R")" 502
check "remaining quota unchanged" "$(remaining "$U3")" "$BEFORE"

echo "4) timeout deneme -> 504 after ~3 s with unchanged quota"
BEFORE=$(remaining "$U3")
T=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' -X POST "$BASE_URL/v1/generations" \
  -H "x-user-id: $U3" -H 'content-type: application/json' --data '{"prompt":"timeout deneme"}')
check "timeout status" "${T%% *}" 504
SECONDS_TAKEN="${T#* }"
if awk "BEGIN { exit !($SECONDS_TAKEN >= 2.9 && $SECONDS_TAKEN < 4.0) }"; then
  pass "timed out after ${SECONDS_TAKEN}s"
else
  fail "timed out after ${SECONDS_TAKEN}s (expected ~3s)"
fi
check "remaining quota unchanged" "$(remaining "$U3")" "$BEFORE"

echo "5) 10 parallel requests (xargs -P 10) -> 5 x 201, 5 x 429"
U5="verify-parallel-$RUN_ID"
CODES=$(seq 1 10 | xargs -P 10 -I{} curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE_URL/v1/generations" \
  -H "x-user-id: $U5" -H 'content-type: application/json' --data "{\"prompt\":\"parallel {} $RUN_ID\"}")
check "201 responses" "$(echo "$CODES" | grep -c '^201$')" 5
check "429 responses" "$(echo "$CODES" | grep -c '^429$')" 5

echo "6) history with limit=2 -> no duplicates or omissions"
ALL=$(curl -s "$BASE_URL/v1/generations?limit=100" -H "x-user-id: $U2" | grep -o '"id":"[^"]*"')
PAGED=""; CURSOR=""; PAGES=0
while :; do
  PAGE=$(curl -s "$BASE_URL/v1/generations?limit=2${CURSOR:+&cursor=$CURSOR}" -H "x-user-id: $U2")
  PAGED="$PAGED$(echo "$PAGE" | grep -o '"id":"[^"]*"')"$'\n'
  PAGES=$((PAGES + 1))
  CURSOR=$(echo "$PAGE" | sed -n 's/.*"nextCursor":"\([^"]*\)".*/\1/p')
  [ -z "$CURSOR" ] || [ "$PAGES" -ge 100 ] && break
done
PAGED=$(echo "$PAGED" | sed '/^$/d')
check "records seen across $PAGES pages" "$(echo "$PAGED" | wc -l | tr -d ' ')" "$(echo "$ALL" | wc -l | tr -d ' ')"
check "duplicates" "$(echo "$PAGED" | sort | uniq -d | wc -l | tr -d ' ')" 0
check "same records in the same order" "$PAGED" "$ALL"

echo
if [ "$FAILURES" -eq 0 ]; then echo "All checks passed."; else echo "$FAILURES check(s) failed."; exit 1; fi
