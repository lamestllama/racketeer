#!/usr/bin/env python3
# Copyright (c) 2026 Eric Parsonage
# SPDX-License-Identifier: Apache-2.0 OR MIT
"""Test one verified VSIX in a fresh editor, workspace, and Racket addon directory."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import plistlib
import selectors
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def editor_layout(code, platform):
    """Accept the distribution's executable, CLI launcher, or macOS bundle."""
    code = Path(shutil.which(str(code)) or code).resolve()
    if platform == 'darwin':
        bundle = next((parent for parent in (code, *code.parents) if parent.suffix == '.app'), None)
        if bundle is None:
            raise ValueError('--code must select a VS Code application bundle or its launcher.')
        with (bundle / 'Contents/Info.plist').open('rb') as source:
            executable = plistlib.load(source)['CFBundleExecutable']
        code = bundle / 'Contents/MacOS' / executable
        app = bundle / 'Contents/Resources/app'
    elif platform == 'win32':
        if code.suffix.lower() == '.cmd':
            code = code.parent.parent / 'Code.exe'
        # Windows archives can keep resources under a build-specific directory.
        candidates = [code.parent / 'resources/app', *code.parent.glob('*/resources/app')]
        apps = [candidate for candidate in candidates if (candidate / 'out/cli.js').is_file()]
        if len(apps) != 1:
            raise ValueError('--code must select a Windows distribution with one resources directory.')
        app = apps[0]
    else:
        if code.parent.name == 'bin':
            code = code.parent.parent / 'code'
        app = code.parent / 'resources/app'
    if not code.is_file() or not (app / 'out/cli.js').is_file():
        raise ValueError('--code must select a standard VS Code distribution.')
    return code, app


@contextmanager
def editor_display(output, env, xvfb):
    if sys.platform != 'linux':
        yield env
        return
    with (output / 'xvfb.log').open('w') as log:
        display = subprocess.Popen(
            [xvfb, '-displayfd', '1', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'],
            stdout=subprocess.PIPE, stderr=log, text=True)
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(display.stdout, selectors.EVENT_READ)
                if not selector.select(10):
                    raise RuntimeError(f'Xvfb startup timed out; see {output / "xvfb.log"}.')
            number = display.stdout.readline().strip()
            if not number.isdecimal():
                raise RuntimeError(f'Xvfb did not create a display; see {output / "xvfb.log"}.')
            yield dict(env, DISPLAY=f':{number}', XDG_SESSION_TYPE='x11')
        finally:
            display.terminate()
            try:
                display.wait(timeout=5)
            except subprocess.TimeoutExpired:
                display.kill()
                display.wait()
            display.stdout.close()


def prepare_run(root, dogfood=False):
    """Never reuse editor, package, workspace, or report state from another run."""
    parent = root / '.test-output' / ('dogfood' if dogfood else 'integration')
    parent.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix='run-', dir=parent))
    workspace = output / 'workspace'
    if dogfood:
        for directory in ('racketdap', 'tests', 'examples', 'vendor', 'vscode'):
            shutil.copytree(root / directory, workspace / directory,
                            ignore=shutil.ignore_patterns('compiled', '__pycache__', 'node_modules'))
        for relative in ('.vscode/settings.json', 'experiments/lexical-eval.rkt'):
            destination = workspace / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / relative, destination)
    else:
        shutil.copytree(root / 'examples', workspace,
                        ignore=shutil.ignore_patterns('compiled', '__pycache__'))
    shutil.copytree(root / 'tests', output / 'harness',
                    ignore=shutil.ignore_patterns('compiled', '__pycache__'))
    # Keep controller-level checks on the same source snapshot as the verified artifact.
    extension_source = output / 'harness' / 'extension'
    extension_source.mkdir()
    for source in (root / 'vscode').glob('*.js'):
        shutil.copyfile(source, extension_source / source.name)
    # Preserve source-relative imports, including nested modules and npm dependencies.
    shutil.copytree(root / 'vscode', output / 'vscode',
                    ignore=shutil.ignore_patterns('compiled', '__pycache__', 'node_modules'))
    try:
        (output / 'vscode' / 'node_modules').symlink_to(root / 'vscode' / 'node_modules', target_is_directory=True)
    except OSError:
        # Windows may refuse symbolic links without developer mode.
        shutil.copytree(root / 'vscode' / 'node_modules', output / 'vscode' / 'node_modules')
    for name in ('user', 'extensions', 'empty-racket-addon'):
        (output / name).mkdir()
    settings = output / 'user/User/settings.json'
    settings.parent.mkdir()
    settings.write_text(json.dumps({
        'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
        'extensions.autoUpdate': False, 'workbench.startupEditor': 'none',
        'window.restoreWindows': 'none',
        # Newer VS Code opens a chat side bar, which leaves the editor too small.
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
        'racket-langserver.workspaceAnalysis.timeoutSeconds': 120,
    }))
    (parent / 'latest.json').write_text(json.dumps({
        'run': str(output), 'report': str(output / 'vscode-report.json')}, indent=2) + '\n')
    return output


def isolated_environment(output, inherited=None):
    env = dict(os.environ if inherited is None else inherited)
    # Collection/configuration and compiled-cache overrides can defeat an empty addon.
    for key in list(env):
        if key.startswith('PLT') or key in ('VSCODE_IPC_HOOK_CLI', 'ELECTRON_RUN_AS_NODE',
                                          'WAYLAND_DISPLAY', 'RACKETDAP_TEST_REPORT',
                                          'RACKETDAP_TEST_RHOMBUS'):
            env.pop(key)
    env['PLTADDONDIR'] = str(output / 'empty-racket-addon')
    return env


def show_failure(log, env=os.environ, count=40):
    """Name a failure in the output, so that reading it needs no downloaded artifact."""
    if not log.is_file():
        return
    tail = '\n'.join(log.read_text(encoding='utf-8', errors='replace').splitlines()[-count:])
    sys.stdout.reconfigure(errors='backslashreplace')
    print(f'Last lines of {log}:\n{tail}', flush=True)
    if env.get('GITHUB_STEP_SUMMARY'):
        with open(env['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
            summary.write(f'### Editor run failed\n\n```\n{tail}\n```\n')


def verify_artifact(artifact, installed=None):
    command = ['node', str(ROOT / 'scripts/artifact.js'), 'verify', str(artifact)]
    if installed:
        command.append(str(installed))
    result = subprocess.run(command, cwd=ROOT, check=True, capture_output=True, encoding='utf-8')
    return json.loads(result.stdout)


def run(args, executable, app, selected):
    identity = verify_artifact(selected)
    output = prepare_run(ROOT, args.dogfood)
    print(f'Editor run: {output}', flush=True)
    print(f'Artifact SHA256: {identity["sha256"]}', flush=True)
    report = output / 'vscode-report.json'
    raw_report = output / 'editor-result.json'
    artifact = output / 'artifact.vsix'
    shutil.copyfile(selected, artifact)
    shutil.copyfile(f'{selected}.build.json', f'{artifact}.build.json')
    evidence = {'passed': False, 'artifact': identity, 'run': str(output),
                'mode': 'dogfood' if args.dogfood else 'integration',
                'rhombusRequested': args.rhombus, 'platform': sys.platform,
                'editor': {'executable': str(executable),
                           'version': json.loads((app / 'package.json').read_text(encoding='utf-8'))['version'],
                           'commit': json.loads((app / 'product.json').read_text(encoding='utf-8')).get('commit')}}
    report.write_text(json.dumps(evidence, indent=2) + '\n')
    try:
        # Pin the run to this private artifact copy, including its content manifest.
        staged = verify_artifact(artifact)
        if staged['sha256'] != identity['sha256']:
            raise RuntimeError('Selected artifact changed while preparing the run.')
        evidence['artifact'].update(retainedPath=staged['path'], retainedManifest=staged['manifest'])
        env = isolated_environment(output)
        if args.rhombus:
            runtime = output / 'rhombus-runtime'
            print(f'Provisioning the pinned Rhombus runtime: {runtime}', flush=True)
            subprocess.run([sys.executable, str(ROOT / 'scripts/provision-rhombus.py'),
                            '--output', str(runtime)], env=env, check=True, timeout=1500)
            evidence['rhombusRuntime'] = json.loads((runtime / 'rhombus-runtime.json').read_text(encoding='utf-8'))
            if not evidence['rhombusRuntime'].get('passed'):
                raise RuntimeError('The requested Rhombus runtime did not pass its probe.')
            env.update(PLTADDONDIR=evidence['rhombusRuntime']['addon'], RACKETDAP_TEST_RHOMBUS='1')
        isolated = [f'--user-data-dir={output / "user"}', f'--extensions-dir={output / "extensions"}']
        with (output / 'install.log').open('w') as install_log:
            # Use the CLI entry point with Electron's Node mode, as the shipped
            # launchers do, without routing filesystem paths through a shell.
            subprocess.run([str(executable), str(app / 'out/cli.js'), *isolated,
                            '--install-extension', str(artifact), '--force'],
                           env=dict(env, ELECTRON_RUN_AS_NODE='1'), stdout=install_log,
                           stderr=subprocess.STDOUT, check=True, timeout=600)
        installed = output / 'extensions' / f'{identity["extension"]}-{identity["version"]}'
        verified = verify_artifact(artifact, installed)
        evidence['artifact'].update(installed=verified['installed'], verifiedFiles=verified['verifiedFiles'])
        test_entry = 'vscode-dogfood.js' if args.dogfood else 'vscode-integration.js'
        env['RACKETDAP_TEST_REPORT'] = str(raw_report)
        platform_args = ['--no-sandbox', '--ozone-platform=x11'] if sys.platform == 'linux' else []
        with editor_display(output, env, args.xvfb) as editor_env, (output / 'vscode.log').open('w') as log:
            subprocess.run([
                str(executable), '--disable-gpu', *platform_args,
                '--disable-extensions', '--disable-workspace-trust', '--skip-welcome',
                '--skip-release-notes', *isolated,
                f'--extensionDevelopmentPath={installed}',
                f'--extensionTestsPath={output / "harness" / test_entry}',
                str(output / 'workspace'),
            ], env=editor_env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=args.timeout)
        result = json.loads(raw_report.read_text(encoding='utf-8'))
        if not result.get('passed'):
            raise RuntimeError(f'Integration did not pass: {result}')
        if result.get('extension') != identity['extension'] or result.get('version') != identity['version']:
            raise RuntimeError('Editor report identifies a different extension from the selected artifact.')
        if result.get('vscode') != evidence['editor']['version']:
            raise RuntimeError('Editor report identifies a different VS Code version from the selected editor.')
        # Catch checkout edits made during the run; they require a new artifact/check.
        verify_artifact(artifact)
        evidence.update(result)
    except Exception as error:
        evidence.update(passed=False, error=str(error))
        show_failure(output / 'vscode.log')
        raise
    finally:
        report.write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--code', default=shutil.which('code'))
    parser.add_argument('--xvfb', default=shutil.which('Xvfb'))
    parser.add_argument('--artifact', type=Path, help='Exact VSIX to verify and install; its .build.json is required.')
    parser.add_argument('--timeout', type=int, default=3600,
                        help='Whole-editor time limit in seconds, which only names a hang (default: 3600).')
    parser.add_argument('--dogfood', action='store_true',
                        help='Run this repository\'s RackUnit suites through the installed Test Explorer.')
    parser.add_argument('--rhombus', action='store_true',
                        help='Provision the locked language runtime privately and require Rhombus editor acceptance (network access required).')
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('--timeout must be a positive number of seconds.')
    if args.rhombus and args.dogfood:
        parser.error('--rhombus selects integration acceptance and cannot be combined with --dogfood.')
    if not args.code or (sys.platform == 'linux' and not args.xvfb):
        parser.error('VS Code is required, plus Xvfb on Linux; set --code and --xvfb if needed.')
    try:
        executable, app = editor_layout(args.code, sys.platform)
    except ValueError as error:
        parser.error(str(error))
    manifest = json.loads((ROOT / 'vscode/package.json').read_text(encoding='utf-8'))
    selected = (args.artifact or ROOT / 'dist' / f'{manifest["name"]}-{manifest["version"]}.vsix').resolve()
    if not selected.is_file():
        parser.error('Build the VSIX first with node scripts/package-extension.js.')
    run(args, executable, app, selected)


if __name__ == '__main__':
    main()
