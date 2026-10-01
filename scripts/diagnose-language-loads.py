#!/usr/bin/env python3
"""Record fresh-process language-load diagnostics without changing the Racket installation."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
LANGUAGES = ('typed/racket/base', 'typed/racket', 'htdp/asl', 'htdp/bsl')
METADATA = '''
(require json)
(write-json
 (hash 'version (version)
       'vm (symbol->string (system-type 'vm))
       'machine (system-type 'machine)
       'executable (path->string (find-system-path 'exec-file))
       'collectsDirectory (path->string (find-system-path 'collects-dir))
       'addonDirectory (path->string (find-system-path 'addon-dir))
       'collectionPaths (map path->string (current-library-collection-paths))
       'compiledPaths (map path->string (use-compiled-file-paths))
       'compiledRoots (map (lambda (path) (format "~s" path)) (current-compiled-file-roots))
       'compileEnforceModuleConstants (compile-enforce-module-constants)))
(newline)
'''


def run_case(label, command, timeout, env=None):
    print(f'\n=== {label} ===', flush=True)
    print('command: ' + json.dumps([str(item) for item in command]), flush=True)
    started = time.monotonic()
    timed_out = False
    try:
        # Each case owns a process group, so a timed-out probe cannot leave a
        # worker behind. Inherit the failing job's Racket environment unchanged.
        with subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, start_new_session=True, env=env) as process:
            try:
                output, _ = process.communicate(timeout=timeout)
            except BaseException as error:
                try:
                    if os.name == 'posix':
                        os.killpg(process.pid, signal.SIGKILL)
                    else:
                        process.kill()
                except ProcessLookupError:
                    pass
                output, _ = process.communicate()
                if not isinstance(error, subprocess.TimeoutExpired):
                    raise
                timed_out = True
            code = process.returncode
        # Retain complete stdout, stderr and the runtime's error context.
        print(output.decode('utf-8', errors='replace'), end='', flush=True)
        if output and not output.endswith(b'\n'):
            print(flush=True)
        result = {'case': label, 'exitCode': code, 'timedOut': timed_out,
                  'elapsedSeconds': round(time.monotonic() - started, 3)}
    except OSError as error:
        result = {'case': label, 'exitCode': None, 'timedOut': False, 'error': str(error)}
    print('result: ' + json.dumps(result), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--racket', default=shutil.which('racket'))
    parser.add_argument('--timeout', type=float, default=60,
                        help='Maximum seconds per fresh Racket process (default: 60).')
    args = parser.parse_args()
    if not args.racket or args.timeout <= 0:
        parser.error('Racket and a positive per-process timeout are required.')
    racket = Path(shutil.which(args.racket) or args.racket).resolve()
    print('Language-load diagnostic; failing test status is not changed.', flush=True)
    print('racket: ' + str(racket), flush=True)
    print('Racket environment overrides: ' + json.dumps({
        key: os.environ[key] for key in (
            'PLTADDONDIR', 'PLTCOLLECTS', 'PLTCONFIGDIR', 'PLTCOMPILEDROOTS',
            'PLTUSERHOME', 'PLT_COMPILED_FILE_CHECK') if key in os.environ}), flush=True)
    stale = []
    checked = 0
    for bytecode in (racket.parent.parent / 'collects').rglob('*.zo'):
        parts = bytecode.stem.rsplit('_', 1)
        if len(parts) != 2:
            continue
        source = bytecode.parent.parent / '.'.join(parts)
        if source.is_file():
            checked += 1
            source_time, compiled_time = source.stat().st_mtime, bytecode.stat().st_mtime
            if int(source_time) > int(compiled_time):
                stale.append({'source': str(source), 'sourceTime': source_time, 'compiledTime': compiled_time})
    print('Installation bytecode timestamps: ' + json.dumps({'checked': checked, 'stale': len(stale), 'examples': stale[:20]}), flush=True)
    results = [run_case('runtime and cache metadata', [racket, '-e', METADATA], args.timeout)]
    with tempfile.TemporaryDirectory(prefix='racketeer-language-diagnostic-') as temporary:
        directory = Path(temporary)
        loader = ROOT / 'racketdap/worker/load.rkt'
        driver = directory / 'loader-probe.rkt'
        driver.write_text(
            '#lang racket/base\n'
            f'(require (file {json.dumps(str(loader), ensure_ascii=False)}))\n'
            '(error-print-context-length 100)\n'
            '(define arguments (current-command-line-arguments))\n'
            '(run-module (string->path (vector-ref arguments 0))\n'
            '            #:instrument? (equal? (vector-ref arguments 1) "instrumented"))\n',
            encoding='utf-8')
        namespace_driver = directory / 'namespace-probe.rkt'
        namespace_driver.write_text(
            '#lang racket/base\n'
            '(parameterize ([current-namespace (make-base-namespace)])\n'
            '  (dynamic-require (string->path (vector-ref (current-command-line-arguments) 0)) #f))\n',
            encoding='utf-8')
        for language in LANGUAGES:
            program = directory / (language.replace('/', '-') + '.rkt')
            program.write_text(
                f'#lang {language}\n'
                + ('(: answer (-> Integer Integer))\n' if language.startswith('typed/') else '')
                + '(define (answer x) (+ x 1))\n(answer 4)\n', encoding='utf-8')
            for mode in ('direct', 'uninstrumented', 'instrumented'):
                command = [racket, program] if mode == 'direct' else [racket, driver, program, mode]
                results.append(run_case(f'{language} / {mode}', command, args.timeout))
        program = directory / 'images.rkt'
        shutil.copyfile(ROOT / 'examples/images.rkt', program)
        for mode in ('direct', 'uninstrumented', 'instrumented'):
            command = [racket, program] if mode == 'direct' else [racket, driver, program, mode]
            results.append(run_case(f'image libraries / {mode}', command, args.timeout))
        results.append(run_case('image libraries / fresh Racket namespace', [racket, namespace_driver, program], args.timeout))
        exists_env = {**os.environ, 'PLT_COMPILED_FILE_CHECK': 'exists'}
        results.append(run_case('image libraries / fresh namespace / ignore timestamps', [racket, namespace_driver, program], args.timeout, exists_env))
        results.append(run_case('image libraries / instrumented / ignore timestamps', [racket, driver, program, 'instrumented'], args.timeout, exists_env))
    print('\nsummary: ' + json.dumps(results), flush=True)
    return int(any(result['exitCode'] != 0 or result['timedOut'] for result in results))


if __name__ == '__main__':
    raise SystemExit(main())
