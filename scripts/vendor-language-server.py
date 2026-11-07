#!/usr/bin/env python3
# Copyright (c) 2026 Eric Parsonage
# SPDX-License-Identifier: Apache-2.0 OR MIT
"""Reproduce the checked-in upstream sources using pinned, verified archives."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile

root = Path(__file__).resolve().parent.parent
packages = json.loads((root / 'vendor/sources.json').read_text(encoding='utf-8'))
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--package', choices=[package['name'] for package in packages],
                    help='Regenerate only this package.')
parser.add_argument('--archive', type=Path, help='Use a local ZIP for --package instead of downloading.')
parser.add_argument('--archive-sha256',
                    help='Expected local ZIP checksum (does not verify the remote archive).')
args = parser.parse_args()
if args.archive and not args.package:
    parser.error('--archive requires --package')
if args.archive_sha256 and not args.archive:
    parser.error('--archive-sha256 requires --archive')
if args.package:
    packages = [package for package in packages if package['name'] == args.package]

for package in packages:
    checksum = args.archive_sha256 or package['sha256']
    if not checksum or len(checksum) != 64 or any(c not in '0123456789abcdef' for c in checksum):
        raise RuntimeError(f"Missing or invalid SHA-256: {package['name']}; "
                           'fill vendor/sources.json or supply --archive-sha256 for a local ZIP')
    data = args.archive.read_bytes() if args.archive else urllib.request.urlopen(package['url'], timeout=60).read()
    if hashlib.sha256(data).hexdigest() != checksum:
        raise RuntimeError(f"Archive checksum mismatch: {package['name']}")
    with tempfile.TemporaryDirectory() as temporary:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for entry in archive.infolist():
                path = PurePosixPath(entry.filename)
                if path.is_absolute() or '..' in path.parts:
                    raise RuntimeError('Unsafe archive path')
            archive.extractall(temporary)
        source = Path(temporary) / package['prefix']
        destination = root / 'vendor/collects' / package['name']
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(source, destination)
    print(f"Verified and copied {package['name']}")

server_patches = ('tail-position-hover.patch', 'predicted-bindings.patch',
                  'clamp-protocol-columns.patch', 'analysis-wait.patch',
                  'lazy-documentation.patch', 'url-string.patch',
                  'source-snapshot-cache.patch', 'contribution-only.patch',
                  'source-snapshot-observations.patch', 'source-snapshot-external-reads.patch',
                  'contribution-only-resources.patch')
for patch_name in server_patches if any(p['name'] == 'racket-langserver' for p in packages) else ():
    patch = root / 'vendor/patches' / patch_name
    subprocess.run(['git', 'apply', '--directory=vendor/collects/racket-langserver', str(patch)],
                   cwd=root, check=True)
    print(f"Applied {patch.name}")
