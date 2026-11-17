#!/bin/sh
# DEBUG / simulator only. Copies a TypeScript-generated fixture into the
# my-secrect App Group container of a simulator, where the DEBUG build of the
# Credential Provider's configuration screen turns it into vault.db + keychain
# items ("Seed test vault" button, Extension/DebugSimulatorSeed.swift).
#
# Usage: scripts/seed-simulator.sh <simulator-udid> [fixture.json]
#   default fixture: tests/AutoFillCoreTests/Fixtures/autofill-fixture.json
#   fresh fixture:   npx tsx native/ios-credential-provider/tests/generate-fixtures.ts /tmp/f.json
# The app must already be installed on that simulator (Debug build).
set -eu

UDID=${1:?usage: seed-simulator.sh <simulator-udid> [fixture.json]}
HERE=$(cd "$(dirname "$0")" && pwd)
FIXTURE=${2:-$HERE/../tests/AutoFillCoreTests/Fixtures/autofill-fixture.json}

GROUP_DIR=$(xcrun simctl get_app_container "$UDID" com.loygenics.my-secrect group.com.loygenics.my-secrect)
TARGET_DIR="$GROUP_DIR/Library/Application Support/my-secrect"
mkdir -p "$TARGET_DIR"
cp "$FIXTURE" "$TARGET_DIR/dev-seed.json"
echo "Copied fixture to $TARGET_DIR/dev-seed.json"
echo "Next: enrol Face ID (Features > Face ID > Enrolled), then Settings > General > AutoFill & Passwords,"
echo "turn on my-secrect and tap 'Seed test vault' on the configuration screen."
