## What this changes

<!-- What changed and why. Link the issue it fixes, if there is one ("Fixes #12"). -->

## How you tested it

<!--
Windows version, controller and stores, and what you did on the TV or PC to check it.
For a change to the page, add a screenshot.
-->

## Checks

- [ ] `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` pass in `src-tauri` (CI runs them on Windows).
- [ ] For a change in `ui/`: `npm --prefix tests test` and `npm --prefix tests run typecheck` pass.
- [ ] A new or changed command, event or payload has its fixture in `tests/ipc/` and a page test that uses it.
- [ ] The docs say what changed, if it changes what Lamplit does on the PC or sends over the network (`docs/security-and-privacy.md`).
- [ ] I agree to the [licence terms for contributions](../CONTRIBUTING.md#licence-of-contributions).
