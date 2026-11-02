#!/usr/bin/env python3
# Copyright (c) 2026 Eric Parsonage
# SPDX-License-Identifier: Apache-2.0 OR MIT
"""Exercise GUI callbacks in a private virtual display."""
import argparse
import os
import selectors
import subprocess
from pathlib import Path
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--xvfb', default='Xvfb')
parser.add_argument('--timeout', type=int, default=300,
                    help='Whole-suite time limit in seconds (default: 300); increase for busy hosts.')
args = parser.parse_args()
if args.timeout <= 0:
    parser.error('--timeout must be a positive number of seconds.')
root = Path(__file__).resolve().parent.parent
with subprocess.Popen([args.xvfb, '-displayfd', '1', '-screen', '0', '1024x768x24', '-nolisten', 'tcp'], stdout=subprocess.PIPE, text=True) as display:
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(display.stdout, selectors.EVENT_READ)
            if not selector.select(10):
                raise RuntimeError('Xvfb startup timed out')
        number = display.stdout.readline().strip()
        if not number.isdecimal():
            raise RuntimeError('Xvfb failed to allocate a display')
        subprocess.run(['node', '--test', '--test-concurrency=1', 'tests/gui-parity.test.js', 'tests/pause.test.js', 'tests/debug-third-party-program.test.js', 'tests/macro-stepper-gui.test.js', 'tests/plots-gui.test.js', 'tests/wxme-edit.test.js', 'tests/wxme-structure.test.js', 'tests/wxme-xml-edit.test.js'],
                       cwd=root, env=dict(os.environ, DISPLAY=f':{number}', RACKETDAP_TEST_WXME_GUI='1'), check=True, timeout=args.timeout)
    finally:
        display.terminate()
