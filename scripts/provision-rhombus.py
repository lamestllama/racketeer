#!/usr/bin/env python3
# Copyright (c) 2026 Eric Parsonage
# SPDX-License-Identifier: Apache-2.0 OR MIT
"""Install the locked Rhombus test runtime into a new private addon directory."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess

LOCK = Path(__file__).with_name('rhombus-runtime-lock.json')
IDENTITY_EXPRESSION = '''
(require pkg/lib json)
(define (packages scope)
  (for/hash ([(name info) (in-hash (installed-pkg-table #:scope scope))])
    (values (string->symbol name)
            (hash 'checksum (pkg-info-checksum info)
                  'source (format "~s" (pkg-info-orig-pkg info))))))
(write-json (hash 'version (version)
                  'vm (symbol->string (system-type 'vm))
                  'installation (packages 'installation)
                  'user (packages 'user)))
'''


def read_lock(path=LOCK):
    data = json.loads(path.read_text())
    if data.get('schema') != 1:
        raise ValueError('Unsupported Rhombus fixture lock schema.')
    names = [package['name'] for package in data['packages']]
    if len(names) != len(set(names)) or 'rhombus-lib' not in names:
        raise ValueError('Rhombus fixture packages must be unique and include rhombus-lib.')
    dependencies = set(names) | set(data['distributionDependencies'])
    for package in data['packages']:
        checksum = package['checksum']
        if (not re.fullmatch('[0-9a-f]{40}', checksum)
                or not package['source'].startswith('https://')
                or not package['source'].endswith('#' + checksum)):
            raise ValueError(f'Package {package["name"]} must use an exact HTTPS Git commit.')
        if not set(package['dependencies']) <= dependencies:
            raise ValueError(f'Package {package["name"]} has an unlocked dependency.')
    return data


def environment(addon, inherited=None):
    env = dict(os.environ if inherited is None else inherited)
    for key in list(env):
        if key.startswith('PLT'):
            env.pop(key)
    env['PLTADDONDIR'] = str(addon)
    return env


def package_identity(racket, env):
    result = subprocess.run([str(racket), '-e', IDENTITY_EXPRESSION], env=env,
                            check=True, capture_output=True, text=True, timeout=60)
    return json.loads(result.stdout)


def verify_packages(identity, lock):
    expected = {package['name']: package['checksum'] for package in lock['packages']}
    actual = {name: package['checksum'] for name, package in identity['user'].items()}
    if actual != expected:
        raise RuntimeError(f'Installed Rhombus package identities differ from the lock: {actual}')


def run_install(command, env, log, timeout=1200):
    # The Linux editor harness owns the whole setup process group, including
    # native package setup children, even if the deadline or a signal interrupts it.
    with subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT,
                          start_new_session=True) as process:
        try:
            return_code = process.wait(timeout=timeout)
        except BaseException:
            try:
                if os.name == 'posix':
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
            except ProcessLookupError:
                pass
            process.wait()
            raise
        if return_code:
            raise subprocess.CalledProcessError(return_code, command)


def provision(output, racket, inherited=None):
    output = output.resolve()
    # Refuse to reuse partially installed or previously tested runtime state.
    output.mkdir(parents=True, exist_ok=False)
    addon = output / 'addon'
    addon.mkdir()
    env = environment(addon, inherited)
    lock = read_lock()
    shutil.copyfile(LOCK, output / 'rhombus-runtime-lock.json')
    evidence = {'passed': False, 'addon': str(addon), 'racket': str(racket),
                'lockSha256': hashlib.sha256(LOCK.read_bytes()).hexdigest(), 'lock': lock}
    report = output / 'rhombus-runtime.json'
    log_path = output / 'rhombus-install.log'
    try:
        before = package_identity(racket, env)
        evidence['before'] = before
        if before['user']:
            raise RuntimeError('Rhombus fixture addon is not empty.')
        missing = set(lock['distributionDependencies']) - set(before['installation'])
        if missing:
            raise RuntimeError(f'Full Racket distribution required; missing packages: {sorted(missing)}')
        command = [str(racket), '-l', 'raco', '--', 'pkg', 'install',
                   '--scope', 'user', '--batch', '--deps', 'fail',
                   '--no-docs', '--jobs', '2', '--no-cache',
                   *[package['source'] for package in lock['packages']]]
        evidence['installCommand'] = command
        report.write_text(json.dumps(evidence, indent=2) + '\n')
        with log_path.open('w') as log:
            run_install(command, env, log)
        after = package_identity(racket, env)
        evidence['after'] = after
        verify_packages(after, lock)
        if before['installation'] != after['installation']:
            raise RuntimeError('The Racket installation package identity changed during provisioning.')
        probe = output / 'runtime-probe.rhm'
        probe.write_text('#lang rhombus\nprintln(6 * 7)\n')
        with (output / 'rhombus-probe.log').open('w') as log:
            result = subprocess.run([str(racket), str(probe)], env=env, stdout=subprocess.PIPE,
                                    stderr=log, text=True, check=True, timeout=120)
            log.write(result.stdout)
        if result.stdout.strip() != '42':
            raise RuntimeError(f'Rhombus runtime probe produced unexpected output: {result.stdout!r}')
        evidence['passed'] = True
    except Exception as error:
        evidence['error'] = str(error)
        raise RuntimeError(f'Rhombus provisioning failed; see {report} and {log_path}: {error}') from error
    finally:
        report.write_text(json.dumps(evidence, indent=2) + '\n')
    return evidence


def main():
    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path,
                        help='New directory for the addon, install log and package identity report.')
    parser.add_argument('--racket', default=shutil.which('racket'))
    args = parser.parse_args()
    if not args.racket:
        parser.error('A full Racket installation is required; set --racket if needed.')
    racket = Path(shutil.which(args.racket) or args.racket).resolve()
    evidence = provision(args.output, racket)
    print(json.dumps({'addon': evidence['addon'], 'report': str(args.output / 'rhombus-runtime.json')}))


if __name__ == '__main__':
    main()
