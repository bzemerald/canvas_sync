#!/bin/bash
# Compiles the tools into bin/ (not committed). Needs the Xcode command line tools.
set -e
cd "$(dirname "$0")"
mkdir -p bin
for t in winid mouse trusted; do swiftc -O -o "bin/$t" "$t.swift"; done
echo "built: $(ls bin | tr '\n' ' ')"
