# Debug across files and nested folders

Open this directory, the `examples` directory, or the repository root as your
VS Code workspace. Use the installed Racket extension.

The call chain crosses four files and three folder levels:

```text
main.rkt                         quote-order
  app/orders.rkt                 order-total
    domain/pricing.rkt           price-with-tax
      domain/tax/rates.rkt        tax-amount
```

Each caller uses the returned value, so all four calls remain on the stack at
the deepest breakpoint. The arithmetic uses exact values.

## Test the Debug REPL

1. Open `domain/tax/rates.rkt`. Click the gutter beside line 5,
   `(define tax (* taxable rate))`, to set a breakpoint.
2. Open **main.rkt** again. From the Command Palette (`Ctrl+Shift+P`), run
   **Racket: Load Current File in Debug REPL**.
3. In the **Debug Console** input at the bottom, enter `(quote-order)` and press
   Enter. This invokes the loaded module; its `main` and `test` submodules do
   not run merely from loading it into the REPL.
4. It should stop in `rates.rkt`. Inspect `taxable` (`180`) and `rate` (`1/10`).
   Expand **Call Stack** to see the callers in `pricing.rkt`, `orders.rkt`,
   and `main.rkt`. Select a caller frame to inspect its locals.
5. Use **Step Out** (`Shift+F11`) to follow the return to a caller, or
   **Continue** (`F5`) to finish. Debug Console shows three returned values on
   separate lines: `198`, `18`, `180` (total, tax, net).
6. Enter `(quote-order 3)`. The same REPL should hit the breakpoint again,
   now with `taxable = 270`. Continue to get `297`, `27`, `270`.
7. To try editor selection evaluation, return to the real `main.rkt` file,
   select only `(quote-order 3)` in the last comment, and run **Racket:
   Evaluate Selection in Debug REPL**. Do not include the `;;` comment marker.
8. After changing code, save it, return to `main.rkt`, and run **Racket:
   Restart Debug REPL for Current File**. Run another expression to check the
   new version. Loading again without restarting reuses the existing session.
9. Click **Stop** (`Shift+F5`) when finished. A Debug REPL deliberately stays
   alive between expressions; ordinary file debugging exits when the program
   completes.

Use **Debug Console** for expressions in a Debug REPL. Its accompanying terminal
is for the program's input and output.

## Test the ordinary REPL

With `main.rkt` open, run **Racket: Load Current File in REPL**. Type
`(quote-order)` at the `>` prompt in the **Racket REPL** terminal. Expect
`198`, `18`, and `180` on separate lines. This is
the ordinary Racket REPL; source breakpoints apply to Debug REPL sessions.

## Run and test the program

**Racket: Run Current File** on `main.rkt` prints
`Total: 198; tax: 18; net: 180`. **Racket: Test Current File** runs its RackUnit test.
All four files have a `module+ test` submodule; opening this example directory
as its own workspace makes all four discoverable in Test Explorer.

From the repository root:

```sh
racket examples/multi-file/main.rkt
raco test examples/multi-file
```
