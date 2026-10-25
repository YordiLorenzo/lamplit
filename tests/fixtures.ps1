# fixtures.ps1 add|remove: fake games on a Windows test PC, for testing discovery and launching outside any store.
# Build the stand-in game first with `cargo build --release` in tests\fixture-game (it shows a window until closed;
# Windows' own small exes such as charmap.exe can't run from another folder). Lamplit looks for loose games in
# <drive>:\Games, so -Root has to be such a folder.
param(
    [Parameter(Mandatory)][ValidateSet('add', 'remove')][string]$Mode,
    [string]$Root = 'C:\Games',
    [string]$Game = "$PSScriptRoot\fixture-game\target\release\fixture-game.exe"
)
$ErrorActionPreference = 'Stop'
$portable = "$Root\LamplitTest Portable"
$gog = "$Root\GOG Games"
if ($Mode -eq 'add') {
    New-Item -ItemType Directory -Force $portable, "$gog\LamplitAlpha\bin" | Out-Null
    Copy-Item $Game "$portable\LamplitTest.exe"
    Copy-Item C:\Windows\explorer.exe "$portable\unins000.exe"        # bigger than the game: must be skipped
    Copy-Item C:\Windows\explorer.exe "$portable\CrashReporter.exe"
    Copy-Item $Game "$gog\LamplitAlpha\bin\alpha.exe"
    Copy-Item C:\Windows\explorer.exe "$gog\LamplitAlpha\bigtool.exe"   # the GOG info file must win over size
    '{"gameId":"1","name":"Lamplit Alpha Quest","playTasks":[{"isPrimary":true,"path":"bin\\alpha.exe"}]}' | Set-Content "$gog\LamplitAlpha\goggame-1.info" -Encoding ascii
    Get-ChildItem $portable, "$gog\LamplitAlpha" -Recurse -File | ForEach-Object { "{0} {1}" -f $_.Length, $_.FullName }
} else {
    # Only the fixtures: GOG Games may also hold real games.
    foreach ($d in $portable, "$gog\LamplitAlpha") { if (Test-Path $d) { Remove-Item $d -Recurse -Force } }
    if ((Test-Path $gog) -and -not (Get-ChildItem $gog -Force)) { Remove-Item $gog }
    'fixtures removed'
}
