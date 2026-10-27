# Contributing to Lamplit

Thanks for helping. Bug reports, games Lamplit misses, new stores, support for more controllers and headsets, and
fixes of any size are welcome. For a large change, please open an issue first so we can agree on the approach
before you spend the time.

Be kind to each other. The maintainer moderates issues and pull requests.

## Reporting a bug

Open an issue with the bug report form. It asks for the Lamplit and Windows versions, your controller and how it is
connected, the store, what happened, and the log, `%LOCALAPPDATA%\lamplit\lamplit.log`. The log names your games and
their folders, so read it before you attach it.

For a game Lamplit doesn't find, or finds twice, also say where the game is installed, whether the store app itself
lists it, and paste the `discovery` lines from the log.

Security problems go through a private report, as [SECURITY.md](SECURITY.md) describes, not a public issue.

## Building on Windows

You need:

- Rust 1.95 or newer, with the MSVC toolchain (`rustup default stable-msvc`);
- the Visual Studio Build Tools with the "Desktop development with C++" workload;
- the WebView2 Runtime, which Windows 11 already has;
- for the installer, the Tauri CLI 2: `cargo install tauri-cli --version '^2' --locked`.

From `src-tauri`:

```powershell
cargo run -- --app                  # a debug build of the app alone, with a console for the log
cargo run                           # the way the logon task starts it: the supervisor, which starts the app
cargo build --release               # target\release\lamplit.exe
cargo tauri build --bundles nsis    # target\release\bundle\nsis\Lamplit_<version>_x64-setup.exe
```

`cargo tauri dev` also works. It starts lamplit.exe without arguments, so you get the supervisor and the app as two
processes; `cargo run -- --app` is simpler while you work on the app.

Good to know:

- Only one Lamplit runs at a time in a Windows session. If an installed Lamplit is running, a second one brings it
  forward and exits, so close the installed one first (Alt+F4) before you start a development build.
- A development build uses the same data folder as an installed one, `%LOCALAPPDATA%\lamplit`, so it sees the same
  prefs, art and logs.
- The page in `ui/` is built into the exe. After you change it, run the build again (cargo notices the change).
- In a debug build, Ctrl+Shift+I opens the WebView's developer tools, and the log also goes to the console.
- `scripts/restart.ps1` swaps a new build in for the installed one and restarts it through its logon task.

## Cross-building from macOS or Linux

Lamplit only runs on Windows, but it builds anywhere with [cargo-xwin](https://github.com/rust-cross/cargo-xwin),
which brings Microsoft's CRT and Windows SDK (it downloads them on first use, under Microsoft's licence terms).

```sh
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
# macOS: clang-cl and lld-link come from Homebrew's llvm and lld
brew install llvm lld
export PATH="$(brew --prefix llvm)/bin:$(brew --prefix lld)/bin:$PATH"

cd src-tauri
cargo xwin build --release --target x86_64-pc-windows-msvc
cargo xwin clippy --all-targets --target x86_64-pc-windows-msvc
cargo xwin test --no-run --target x86_64-pc-windows-msvc
```

On Linux, install clang, lld and llvm from your distribution instead of Homebrew.

The exe lands in `target/x86_64-pc-windows-msvc/release/lamplit.exe`. `cargo xwin test --no-run` prints the path
of the test exe (`target/x86_64-pc-windows-msvc/debug/deps/lamplit_lib-<hash>.exe`): copy it to a Windows PC and run
it there. The tests read their fixtures at build time, so that PC doesn't need the repository.

Tauri can also cross-build the NSIS installer with `cargo tauri build --runner cargo-xwin --target
x86_64-pc-windows-msvc --bundles nsis`, which needs `makensis` (Homebrew's `nsis` package). Tauri calls this
experimental, so check the result on Windows.

## Tests

### Rust tests (Windows)

Run `cargo test` in `src-tauri` on Windows. The tests sit next to the code they test, in `#[cfg(test)] mod tests`.
Several use the real system: they make and remove folders under `%TEMP%`, and read the process list, file paths and
the Windows region. None of them changes a setting.

The payloads Rust sends the page are tested against the JSON in `tests/ipc/`, which the page's tests use too. When
you change a payload, change its fixture, and both sides' tests tell you what else has to follow.

To test discovery and launching of games outside any store, `tests/fixture-game` is a stand-in game (a window that
stays open until closed) and `tests/fixtures.ps1` places copies of it. From the repository's root:

```powershell
cargo build --release --manifest-path tests\fixture-game\Cargo.toml
.\tests\fixtures.ps1 add -Root D:\Games      # then start Lamplit and look for the test games
.\tests\fixtures.ps1 remove -Root D:\Games
```

### Page tests (any system with Node)

The page's tests run in Node and Chromium with a fake Tauri, so they don't need Windows:

```sh
npm --prefix tests ci
npm --prefix tests exec -- playwright-core install --no-shell chromium   # or set CHROME to a Chrome or Edge exe
npm --prefix tests test
npm --prefix tests run typecheck
```

- `logic.test.mjs` tests the pure functions in `ui/logic.js`.
- `screensaver.test.mjs` tests the screensaver's palettes (`ui/screensaver/palette.js`) and its list of scenes.
- `contract.test.mjs` checks that the page and the Rust core agree on every command, argument and event.
- `ui.test.mjs` drives the page in Chromium at 1920 x 1080 and other sizes. `page.mjs` serves the page the way
  Tauri serves it on Windows, under the same content security policy, with a fake Tauri that refuses any call Rust
  would refuse. It writes screenshots to `tests/shots/`. `PERF=1` adds timing checks, which depend on the machine.

The art checks use small generated images. For realistic covers in the screenshots, copy `%LOCALAPPDATA%\lamplit\art`
from a Windows PC that has run Lamplit to `tests/art` (it is ignored by git).

The screensaver's scenes also run in a normal browser. Serve the repository's folder (`python3 -m http.server 8123`)
and open `http://localhost:8123/ui/screensaver/preview.html`: its corner lists the keys, and an image dropped on it
colours the scenes. `?cap=0` in the address draws as fast as the GPU can, so the frame rate shows what a scene costs.

`node tests/screenshots.mjs [art folder]` takes the README's screenshots in `docs/images/`. It needs the art of the
games it shows, laid out like `%LOCALAPPDATA%\lamplit\art`; the list of games is at the top of the script.

## Code style

**Rust**

- Format with `cargo fmt` (the settings are in `rustfmt.toml`: 120 columns).
- Keep `cargo clippy --all-targets -- -D warnings` passing. Clippy's pedantic lints are on, with a few exceptions
  listed in `Cargo.toml`, each with its reason.
- Unsafe code belongs in `src/win` only; the rest of the crate denies it. Every `unsafe` block gets a `// SAFETY:`
  comment that says why it is sound.
- A command that touches the disk, the registry, COM, HID, a socket or the process list is `async` and does its work
  in `blocking`: a plain command runs on the main thread and would freeze the window.
- `Error::Player` carries a message written for the player; `Error::Internal` one written for the log.
- Never follow a path from a store's files to a network share or outside the folder it belongs in: use
  `files::on_a_drive` and `files::inside`.

**The page**

- Plain ES modules, no bundler and no runtime packages. Every file starts with `// @ts-check` and types its data
  with JSDoc.
- Only `ui/api.js` names commands and events.
- Logic that doesn't need the DOM goes in `ui/logic.js`, with tests in `tests/logic.test.mjs`.

**Comments and text**

- Comments say why, not what: the Windows behaviour, the store quirk or the failure the code is there for. Name the
  API or file it relies on.
- Text the player reads is short, plain and specific. It says what happened and what to do next.
- Add a dependency only with a reason, and say it in the pull request.

## Adding a store

1. Write `src-tauri/src/stores/<store>.rs` with:
   - `exe()`: where the store app is installed, from the registry entry its installer writes;
   - `games()`: the installed games, each a `Game` with an id of the form `<store>:<its id>`, its install folder,
     and how to launch it (a link the store handles, an exe, or the store app's exe with arguments);
   - `remembered()`, if the store keeps a saved sign-in Lamplit can detect.
2. Add a variant to `Store` in `stores/mod.rs`, fill in each of its `match`es (`key`, `name`, `games`, `exe`,
   `window` and the account check in `status`), and put it in `ALL`. A folder that two stores claim goes to the
   store that comes first in `ALL`.
3. If the store's launcher also has to run for games bought elsewhere, teach `requirements` in `stores/mod.rs` to
   spot them by a file in their folder.
4. Add the store's key to `StoreKey` in `ui/api.js` and to `STORE_ORDER` in `ui/logic.js`, and its logo to
   `ui/index.html` as a `store-<key>` symbol.
5. Test the parsing with small samples of the store's real files, written into a temporary folder the way
   `stores/loose.rs` does.
6. Add the store to the tables in `README.md`, and to `docs/security-and-privacy.md` if Lamplit now reads or changes
   anything new.

Controllers and headsets live in `src-tauri/src/devices/`; [docs/accessories.md](docs/accessories.md) explains the
protocols, and [docs/architecture.md](docs/architecture.md) the rest of the code.

## Commits and pull requests

- One topic per commit. The first line says what changes, in plain words, in about 72 characters; the body says why,
  when that isn't obvious.
- In the pull request, say what changed and how you tested it on Windows: which stores, which controller and how it
  was connected. Add screenshots for changes to the screen.
- Before you send it: `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, `cargo test` (on Windows, or the
  cross-built test exe), and `npm --prefix tests test` when the page or a payload changed. CI runs the same checks
  on every pull request, the Rust ones on Windows, and also builds the installer.
- Update the docs in the same pull request: `README.md` for what players see, `docs/security-and-privacy.md` for
  anything Lamplit changes on the PC or sends online, and `CHANGELOG.md` under the next version.

### Licence of contributions

Lamplit is published under the [PolyForm Noncommercial License 1.0.0](LICENSE). By sending a pull request, you
agree that:

- your contribution is your own work (or you have the right to submit it), and it is shared under the same licence;
- you also grant YordiLorenzo a perpetual, worldwide, non-exclusive, royalty-free licence to use, change, sublicense
  and relicense your contribution, including under commercial terms. This keeps it possible to offer Lamplit under
  other terms later (for example a paid build) without tracking down every past contributor.

The pull request template asks you to confirm this.
