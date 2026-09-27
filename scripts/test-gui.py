#!/usr/bin/env python3
"""Exercise GUI callbacks in a private virtual display."""
import argparse
import os
import selectors
import subprocess
from pathlib import Path
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--xvfb', default='Xvfb')
args = parser.parse_args()
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
        subprocess.run(['node', '--test', '--test-concurrency=1', 'tests/gui-parity.test.js', 'tests/macro-stepper-gui.test.js'],
                       cwd=root, env=dict(os.environ, DISPLAY=f':{number}'), check=True, timeout=90)
    finally:
        display.terminate()
