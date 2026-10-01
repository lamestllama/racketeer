"""Editor orchestration regressions without launching an editor."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('editor_harness', Path(__file__).resolve().parents[1] / 'scripts/test-vscode.py')
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)
runtime_spec = importlib.util.spec_from_file_location(
    'rhombus_fixture', Path(__file__).resolve().parents[1] / 'scripts/provision-rhombus.py')
runtime = importlib.util.module_from_spec(runtime_spec)
runtime_spec.loader.exec_module(runtime)


class EditorIsolation(unittest.TestCase):
    def test_distribution_paths_resolve_without_shell_quoting(self):
        layouts = [
            ('linux', 'code', 'resources/app', ['code', 'bin/code']),
            ('win32', 'Code.exe', 'resources/app', ['Code.exe', 'bin/code.cmd']),
            ('darwin', 'Editor.app/Contents/MacOS/Electron', 'Editor.app/Contents/Resources/app',
             ['Editor.app', 'Editor.app/Contents/MacOS/Electron', 'Editor.app/Contents/Resources/app/bin/code']),
        ]
        with tempfile.TemporaryDirectory(prefix='editor paths λ & ') as temporary:
            for platform, executable, app, entries in layouts:
                root = Path(temporary) / platform
                for relative in (executable, app + '/out/cli.js', *[p for p in entries if not p.endswith('.app')]):
                    file = root / relative
                    file.parent.mkdir(parents=True, exist_ok=True)
                    file.touch()
                for entry in entries:
                    with self.subTest(platform=platform, entry=entry):
                        self.assertEqual(harness.editor_layout(root / entry, platform),
                                         ((root / executable).resolve(), (root / app).resolve()))
                (root / app / 'out/cli.js').unlink()
                with self.assertRaises(ValueError):
                    harness.editor_layout(root / executable, platform)

    def test_native_desktop_does_not_start_a_virtual_display_or_change_environment(self):
        env = {'DISPLAY': 'user display', 'PLTADDONDIR': 'private addon'}
        for platform in ('win32', 'darwin'):
            with patch.object(harness.sys, 'platform', platform), patch.object(harness.subprocess, 'Popen') as spawn:
                with harness.editor_display(Path('/unused'), env, None) as actual:
                    self.assertEqual(actual, env)
                spawn.assert_not_called()

    def test_previous_workspace_profile_extensions_and_addon_are_never_reused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for relative in ('tests/vscode-integration.js', 'tests/vscode-dogfood.js',
                             'racketdap/main.rkt', 'examples/demo.rkt',
                             '.vscode/settings.json', 'experiments/lexical-eval.rkt'):
                file = root / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('fixture')
            for relative in ('examples/nested/compiled/demo_rkt.zo',
                             'examples/__pycache__/helper.pyc',
                             'tests/compiled/check_rkt.zo'):
                file = root / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('checkout cache')
            for dogfood in (False, True):
                first = harness.prepare_run(root, dogfood)
                for name in ('workspace', 'user', 'extensions', 'empty-racket-addon'):
                    (first / name / 'contamination').write_text('old run')
                second = harness.prepare_run(root, dogfood)
                self.assertNotEqual(first, second)
                for name in ('workspace', 'user', 'extensions', 'empty-racket-addon'):
                    self.assertFalse((second / name / 'contamination').exists())
                    self.assertTrue((first / name / 'contamination').exists())
                self.assertTrue((second / 'harness/vscode-integration.js').is_file())
                for directory in ('workspace', 'harness'):
                    self.assertFalse(list((second / directory).rglob('compiled')))
                    self.assertFalse(list((second / directory).rglob('__pycache__')))
                latest = json.loads((second.parent / 'latest.json').read_text())
                self.assertEqual(latest['run'], str(second))
                self.assertEqual(latest['report'], str(second / 'vscode-report.json'))

    def test_inherited_collection_and_compiled_cache_paths_are_removed(self):
        inherited = dict(PATH='/bin', PLTCOLLECTS='/contaminated', PLTADDONDIR='/old',
                         PLTCONFIGDIR='/config', PLTCOMPILEDROOTS='/compiled',
                         VSCODE_IPC_HOOK_CLI='/ipc', ELECTRON_RUN_AS_NODE='1',
                         WAYLAND_DISPLAY='wayland-1', RACKETDAP_TEST_REPORT='/old-report',
                         RACKETDAP_TEST_RHOMBUS='1')
        env = harness.isolated_environment(Path('/fresh'), inherited)
        self.assertEqual(env, {'PATH': '/bin', 'PLTADDONDIR': str(Path('/fresh') / 'empty-racket-addon')})
        self.assertEqual(inherited['PLTADDONDIR'], '/old')


class RhombusFixture(unittest.TestCase):
    def test_committed_lock_covers_every_extra_dependency(self):
        lock = runtime.read_lock()
        self.assertEqual({package['name'] for package in lock['packages']}, {
            'rhombus-lib', 'shrubbery-lib', 'enforest-lib', 'pretty-expressive-lib'})

    def test_unlocked_dependency_or_moving_source_is_rejected(self):
        for change in ('dependency', 'source'):
            lock = runtime.read_lock()
            if change == 'dependency':
                lock['packages'][0]['dependencies'].append('unlocked-package')
            else:
                lock['packages'][0]['source'] = 'https://example.com/repo.git#main'
            with tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / 'lock.json'
                path.write_text(json.dumps(lock))
                with self.assertRaises(ValueError):
                    runtime.read_lock(path)

    def test_unexpected_package_or_wrong_commit_is_rejected(self):
        lock = runtime.read_lock()
        packages = {p['name']: {'checksum': p['checksum']} for p in lock['packages']}
        runtime.verify_packages({'user': packages}, lock)
        packages['rhombus-lib'] = {'checksum': 'wrong'}
        with self.assertRaises(RuntimeError):
            runtime.verify_packages({'user': packages}, lock)
        packages['rhombus-lib'] = {'checksum': lock['packages'][-1]['checksum']}
        packages['unexpected'] = {'checksum': 'wrong'}
        with self.assertRaises(RuntimeError):
            runtime.verify_packages({'user': packages}, lock)

    def test_failed_download_fails_and_retains_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'runtime'
            before = {'user': {}, 'installation': {
                name: {'checksum': 'distribution'}
                for name in runtime.read_lock()['distributionDependencies']}}
            with patch.object(runtime, 'package_identity', return_value=before), \
                    patch.object(runtime, 'run_install', side_effect=OSError('network unavailable')):
                with self.assertRaisesRegex(RuntimeError, 'network unavailable'):
                    runtime.provision(output, Path('/racket'), {'PLTADDONDIR': '/old'})
            evidence = json.loads((output / 'rhombus-runtime.json').read_text())
            self.assertFalse(evidence['passed'])
            self.assertEqual(evidence['addon'], str((output / 'addon').resolve()))
            self.assertIn('--deps', evidence['installCommand'])
            self.assertIn('fail', evidence['installCommand'])
            self.assertTrue((output / 'rhombus-install.log').is_file())
            with self.assertRaises(FileExistsError):
                runtime.provision(output, Path('/racket'))


if __name__ == '__main__':
    unittest.main()
