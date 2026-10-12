#!/usr/bin/env bash
# Starts the Realtime Database emulator for load and abuse tests, with the
# repository's database.rules.json, on 127.0.0.1:9460 (namespace
# rampridge-world). Nothing here can reach the production database: the
# emulator is local and the dev API only uses it when
# FIREBASE_DATABASE_EMULATOR_HOST is set.
#
#   bash scripts/load/emulator.sh            # foreground; Ctrl-C to stop
#   PORT=9470 bash scripts/load/emulator.sh  # a second, independent emulator
#
# The CLI refuses rules outside its project directory, so the config and a
# copy of the rules are staged in a temporary directory first.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
stage="$(mktemp -d "${TMPDIR:-/tmp}/rampridge-emulator.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
port="${PORT:-9460}"
offset=$((port - 9460))
# Hub and logging ports move with the database port so two emulators can run side by side.
sed -e "s/9460/$port/" -e "s/4460/$((4460 + offset))/" -e "s/4560/$((4560 + offset))/" \
  "$here/firebase.json" > "$stage/firebase.json"
cp "$root/database.rules.json" "$stage/database.rules.json"
cd "$stage"
firebase emulators:start --only database --project peerlyticsapp --config firebase.json
