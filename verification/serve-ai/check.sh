#!/bin/sh
# Model-check the "Ask AI for a fix" model (AskAi.tla) with TLC.
# TLC v1.7.4 is pinned by hash: the v1.8.0 download is rebuilt in place, so its hash changes.
# Usage: verification/serve-ai/check.sh   (from anywhere; needs Java 11+ and curl)
# Exit 0: every rule holds. Exit 12: a rule breaks (TLC prints the trace).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
version=1.7.4
sha=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
jar="${TLA2TOOLS:-${XDG_CACHE_HOME:-$HOME/.cache}/crashlens/tla2tools-$version.jar}"
if [ ! -f "$jar" ]; then
  mkdir -p "$(dirname "$jar")"
  curl -fsSL -o "$jar.tmp" "https://github.com/tlaplus/tlaplus/releases/download/v$version/tla2tools.jar"
  echo "$sha  $jar.tmp" | sha256sum -c - >/dev/null
  mv "$jar.tmp" "$jar"
fi
cd "$here"
exec "${JAVA:-java}" -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers 1 -cleanup \
  -metadir "${TMPDIR:-/tmp}/crashlens-tlc-$$" -config AskAi.cfg AskAi.tla
