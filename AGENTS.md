# Agent notes

For the maintainer's coding agents. Contributors start at [CONTRIBUTING.md](CONTRIBUTING.md).

- Lamplit ships unsigned for now. Don't bring up code signing again until the maintainer does (2026-11-09).
- Build, install, test and run Lamplit end to end without asking first, also on TOASTER, the maintainer's TV PC
  (2026-11-09).
- Build the Windows builds on TOASTER itself, not on another machine with a copy to TOASTER afterwards (2026-11-11).
- Feature requests from Lamplit users go on the roadmap ([ROADMAP.md](ROADMAP.md)) and get built without asking the
  maintainer first (2026-11-17).
- Drive Lamplit and other apps on TOASTER with oriel (the `toaster-uia` MCP server) (noted 2026-11-20).
- The TV has adb on. Set the TV up over adb, not with steps for the maintainer (noted 2026-11-20).
- Before you give button steps for a controller, check if it is paired, and to which device (noted 2026-11-20).
- Lamplit takes every kind of game art the player gives it, and one trailer per game (noted 2026-11-20).
- Lamplit stays in front while a .bat or .cmd launcher runs (noted 2026-11-20).
- The PS5 tile starts Veyra (PS Remote Play with frame generation) from a .cmd script. A launch from Lamplit goes
  straight into the stream. Frame generation is the reason for Veyra: never turn it off. Leave Veyra's gamma as it
  is: it changes the picture (noted 2026-11-20).
