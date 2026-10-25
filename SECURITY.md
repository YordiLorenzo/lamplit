# Security policy

## Supported versions

Security fixes go into the latest release only.

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately through GitHub instead: on the
repository's **Security** tab, choose **Report a vulnerability**, or go straight to
<https://github.com/YordiLorenzo/lamplit/security/advisories/new>.

A useful report says:

- the Lamplit version and the Windows version;
- what an attacker needs: another program running as the same account, another Windows account on the PC, or
  something on the network;
- the steps, or a proof of concept;
- what it lets the attacker do.

Expect a first answer within a week. Lamplit is maintained in spare time, so a fix can take longer, but you'll hear
what happens next and when the fix ships. You'll be credited in the advisory unless you'd rather not be.

### Worth reporting

For example:

- a way to make `lamplit.exe --setup` run code of someone else's choosing with admin rights;
- a way for another program or account to make Lamplit start a program, follow a network path, or read files
  outside its art folders;
- the page loading anything from the network, or reaching commands it shouldn't;
- Steam's DevTools port staying open after you switched the setting off and restarted Steam.

Not in scope: the risk of Steam's DevTools port while you have it switched on (described below), Windows' warnings
about unsigned builds, and problems in Steam, the store apps or Windows themselves. Please report those to their
makers.

## What runs with admin rights

Only first-time setup: `lamplit.exe --setup`, started from Lamplit's Settings through Windows' admin prompt or from a
terminal opened as administrator. It does two things.

**1. It repairs Steam's background service** by running Valve's `<Steam>\bin\SteamService.exe /repair`. Steam lets
every account on the PC write to its folder and to its install path in the registry, so before it runs anything,
setup:

- follows Steam's install path only when it is on a fixed drive of this PC (looking for a file on a network share
  would sign the elevated process in to that server with the administrator's account);
- opens SteamService.exe and keeps it open with read sharing only, so nobody can change or replace it until it has
  run;
- runs it from the final path of that open file, so a junction swapped in meanwhile can't send it elsewhere;
- checks that its Authenticode signature is valid and names Valve Corp., and runs nothing otherwise.

**2. It registers the logon task** `lamplit-<the account's SID>`, which starts lamplit.exe at sign-in with the
account's normal rights (an interactive token, least privilege). The task runs lamplit.exe from its install folder,
`%LOCALAPPDATA%\Lamplit` by default, which the account can write to. Replacing that exe gains nothing: the task
runs it with the same account's normal rights.

lamplit.exe is linked with `/DEPENDENTLOADFLAG:0x800` (`LOAD_LIBRARY_SEARCH_SYSTEM32`), so Windows loads the DLLs it
imports from System32 only, and a DLL placed next to lamplit.exe can't load into setup.

Everything else, the app and the supervisor that restarts it, runs with the account's normal rights. The installer
asks for no admin rights. The uninstaller asks for them only to delete the logon task, which setup registered as
administrator.

## Steam's DevTools port

Steam has a Chromium DevTools endpoint built in. When it is open, it listens on `127.0.0.1:8080` with **no
authentication**: any program on the PC, run by any Windows account, can connect, run JavaScript in the Steam client
and so change Steam's settings or a game's launch options.

- **Off by default.** Lamplit opens the port only while **Settings > Stores > Steam's DevTools port** is on. It then
  creates the empty file `.cef-enable-remote-debugging` in Steam's folder, which makes Steam open the port at every
  start (also when Steam starts by itself at sign-in), and passes `-cef-enable-debugging` when it starts Steam.
- **What Lamplit does with it.** It connects to Steam's `SharedJSContext` and uses `Runtime.evaluate` to read and set
  three settings: **Guide Button Focuses Steam** (switched off, so the PS button doesn't open Big Picture) and,
  while quiet mode is on, Steam's two notification switches. Nothing else. The connection goes straight to
  `127.0.0.1`, never through a proxy.
- **Turning it off.** Switch the setting off, which deletes the file, then restart Steam. If you opened the port
  another way (Steam launch options, a shortcut), remove that too: Lamplit uses an open port whoever opened it.
- **Checking it.** While Steam runs, <http://127.0.0.1:8080/json> answers only when the port is open.

## What the page can reach

Lamplit's interface is a local page shown by WebView2 and built into lamplit.exe.

- It loads nothing from the network. Its content security policy allows scripts, styles and documents only from
  Lamplit itself (`default-src 'self'`), and images only from Lamplit and its art folders.
- Tauri's asset protocol, which serves the art, has no folders in its configuration. At run time Lamplit adds two:
  its own art folder and Steam's library cache.
- The page may call Lamplit's own commands, listen to its events and write to its log, nothing else
  (`src-tauri/capabilities/default.json`). [docs/architecture.md](docs/architecture.md#commands) lists the commands.
- Release builds can't open the WebView's developer tools; debug builds can.

## What goes online

Only requests for game art to Steam's public store (`store.steampowered.com`, `api.steampowered.com`,
`shared.steamstatic.com`), and only while **Find art online** is on: the names of games that aren't from Steam, Steam
app ids, and the country of the Windows region. No accounts, no telemetry, no update checks.
[What Lamplit changes on your PC, and what it sends](docs/security-and-privacy.md) has the details.

## Downloads

Release builds aren't code-signed yet, so Windows shows a SmartScreen warning when you run the installer. Download
Lamplit only from this repository's
[Releases page](https://github.com/YordiLorenzo/lamplit/releases).
