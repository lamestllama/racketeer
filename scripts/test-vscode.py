#!/usr/bin/env python3
"""Test one verified VSIX in a fresh Linux editor, workspace, and Racket addon directory."""
import argparse
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def prepare_run(root, dogfood=False):
    """Never reuse editor, package, workspace, or report state from another run."""
    parent = root / '.test-output' / ('dogfood' if dogfood else 'integration')
    parent.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(prefix='run-', dir=parent))
    workspace = output / 'workspace'
    if dogfood:
        for directory in ('racketdap', 'tests', 'examples'):
            shutil.copytree(root / directory, workspace / directory,
                            ignore=shutil.ignore_patterns('compiled', '__pycache__'))
        for relative in ('.vscode/settings.json', 'experiments/lexical-eval.rkt'):
            destination = workspace / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / relative, destination)
    else:
        shutil.copytree(root / 'examples', workspace,
                        ignore=shutil.ignore_patterns('compiled', '__pycache__'))
    shutil.copytree(root / 'tests', output / 'harness',
                    ignore=shutil.ignore_patterns('compiled', '__pycache__'))
    for name in ('user', 'extensions', 'empty-racket-addon'):
        (output / name).mkdir()
    settings = output / 'user/User/settings.json'
    settings.parent.mkdir()
    settings.write_text(json.dumps({
        'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
        'extensions.autoUpdate': False, 'workbench.startupEditor': 'none',
        'window.restoreWindows': 'none',
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


def verify_artifact(artifact, installed=None):
    command = ['node', str(ROOT / 'scripts/artifact.js'), 'verify', str(artifact)]
    if installed:
        command.append(str(installed))
    result = subprocess.run(command, cwd=ROOT, check=True, capture_output=True, text=True)
    return json.loads(result.stdout)


def run(args, executable, cli, selected):
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
                'rhombusRequested': args.rhombus}
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
            evidence['rhombusRuntime'] = json.loads((runtime / 'rhombus-runtime.json').read_text())
            if not evidence['rhombusRuntime'].get('passed'):
                raise RuntimeError('The requested Rhombus runtime did not pass its probe.')
            env.update(PLTADDONDIR=evidence['rhombusRuntime']['addon'], RACKETDAP_TEST_RHOMBUS='1')
        isolated = [f'--user-data-dir={output / "user"}', f'--extensions-dir={output / "extensions"}']
        with (output / 'install.log').open('w') as install_log:
            subprocess.run([str(cli), *isolated, '--install-extension', str(artifact), '--force'],
                           env=env, stdout=install_log, stderr=subprocess.STDOUT, check=True, timeout=60)
        installed = output / 'extensions' / f'{identity["extension"]}-{identity["version"]}'
        verified = verify_artifact(artifact, installed)
        evidence['artifact'].update(installed=verified['installed'], verifiedFiles=verified['verifiedFiles'])
        test_entry = 'vscode-dogfood.js' if args.dogfood else 'vscode-integration.js'
        with (output / 'xvfb.log').open('w') as xlog, (output / 'vscode.log').open('w') as log:
            display = subprocess.Popen(
                [args.xvfb, '-displayfd', '1', '-screen', '0', '1280x900x24', '-nolisten', 'tcp'],
                stdout=subprocess.PIPE, stderr=xlog, text=True)
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(display.stdout, selectors.EVENT_READ)
                    if not selector.select(10):
                        raise RuntimeError(f'Xvfb startup timed out; see {output / "xvfb.log"}.')
                number = display.stdout.readline().strip()
                if not number.isdecimal():
                    raise RuntimeError(f'Xvfb did not create a display; see {output / "xvfb.log"}.')
                env.update(DISPLAY=f':{number}', XDG_SESSION_TYPE='x11', RACKETDAP_TEST_REPORT=str(raw_report))
                subprocess.run([
                    str(executable), '--no-sandbox', '--disable-gpu', '--ozone-platform=x11',
                    '--disable-extensions', '--disable-workspace-trust', '--skip-welcome',
                    '--skip-release-notes', *isolated,
                    f'--extensionDevelopmentPath={installed}',
                    f'--extensionTestsPath={output / "harness" / test_entry}',
                    str(output / 'workspace'),
                ], env=env, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=args.timeout)
            finally:
                display.terminate()
                try:
                    display.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    display.kill()
                    display.wait()
                display.stdout.close()
        result = json.loads(raw_report.read_text())
        if not result.get('passed'):
            raise RuntimeError(f'Integration did not pass: {result}')
        if result.get('extension') != identity['extension'] or result.get('version') != identity['version']:
            raise RuntimeError('Editor report identifies a different extension from the selected artifact.')
        # Catch checkout edits made during the run; they require a new artifact/check.
        verify_artifact(artifact)
        evidence.update(result)
    except Exception as error:
        evidence.update(passed=False, error=str(error))
        raise
    finally:
        report.write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--code', default=shutil.which('code'))
    parser.add_argument('--xvfb', default=shutil.which('Xvfb'))
    parser.add_argument('--artifact', type=Path, help='Exact VSIX to verify and install; its .build.json is required.')
    parser.add_argument('--timeout', type=int, default=600,
                        help='Whole-editor time limit in seconds (default: 600); increase for busy hosts. Individual assertion deadlines are unchanged.')
    parser.add_argument('--dogfood', action='store_true',
                        help='Run this repository\'s RackUnit suites through the installed Test Explorer.')
    parser.add_argument('--rhombus', action='store_true',
                        help='Provision the locked language runtime privately and require Rhombus editor acceptance (network access required).')
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error('--timeout must be a positive number of seconds.')
    if args.rhombus and args.dogfood:
        parser.error('--rhombus selects integration acceptance and cannot be combined with --dogfood.')
    if not args.code or not args.xvfb:
        parser.error('VS Code and Xvfb are required; set --code and --xvfb if needed.')
    code = Path(shutil.which(args.code) or args.code).resolve()
    executable = code.parent.parent / 'code' if code.parent.name == 'bin' else code
    cli = executable.parent / 'bin/code'
    if not executable.is_file() or not cli.is_file():
        parser.error('--code must select a standard Linux VS Code executable or bin/code launcher.')
    manifest = json.loads((ROOT / 'vscode/package.json').read_text())
    selected = (args.artifact or ROOT / 'dist' / f'{manifest["name"]}-{manifest["version"]}.vsix').resolve()
    if not selected.is_file():
        parser.error('Build the VSIX first with node scripts/package-extension.js.')
    run(args, executable, cli, selected)


if __name__ == '__main__':
    main()
