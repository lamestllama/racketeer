#!/usr/bin/env python3
"""Reproduce the checked-in upstream sources using pinned, verified archives."""
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
for package in json.loads((root / 'vendor/sources.json').read_text()):
    data = urllib.request.urlopen(package['url'], timeout=60).read()
    if hashlib.sha256(data).hexdigest() != package['sha256']:
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

for patch_name in ('semantic-token-viewport.patch', 'watched-create-ownership.patch'):
    patch = root / 'vendor/patches' / patch_name
    subprocess.run(['git', 'apply', '--directory=vendor/collects/racket-langserver', str(patch)],
                   cwd=root, check=True)
    print(f"Applied {patch.name}")
