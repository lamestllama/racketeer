#!/usr/bin/env bash
set -euo pipefail

# Preserve the distribution's source and bytecode timestamps. A plain recursive
# copy can make sources newer than their bytecode and break submodule loading.
version=${1:?Racket version required}
architecture=${2:?Racket architecture required}
if [[ $version == stable ]]; then
  version=$(python -c 'import re, urllib.request; print(re.search(r"\(stable \"([^\"]+)\"\)", urllib.request.urlopen("https://download.racket-lang.org/version.txt").read().decode()).group(1))')
fi
case $architecture in
  arm64 | aarch64) architecture=aarch64 ;;
  x64) architecture=x86_64 ;;
  *) echo "Unsupported macOS architecture: $architecture" >&2; exit 1 ;;
esac
installation=$(mktemp -d "$RUNNER_TEMP/racket-install.XXXXXX")
curl --fail --location --retry 3 \
  "https://download.racket-lang.org/installers/$version/racket-$version-$architecture-macosx-cs.dmg" \
  --output "$installation/racket.dmg"
hdiutil attach "$installation/racket.dmg" -mountpoint "$installation/volume" -nobrowse
trap 'hdiutil detach "$installation/volume"' EXIT
bundles=("$installation/volume"/Racket*)
[[ ${#bundles[@]} == 1 && -d ${bundles[0]} ]]
cp -pR "${bundles[0]}" "$installation/Racket"
echo "$installation/Racket/bin" >> "$GITHUB_PATH"
