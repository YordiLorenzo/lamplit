// Games outside any store: folders in <drive>:\Games, installed programs that look like games, and the exes Windows
// has seen run as games.

use super::gog;
use super::installed::{Installed, Program, pick_exe, skip_exe};
use super::names::{clean_name, prettify};
use crate::files::{file_name, folder_key, subdirs};
use crate::library::{Game, Launch};
use std::path::{Path, PathBuf};

// Launcher and store folders, and Windows' cache of installers: their exes are never games.
const NOT_GAME_DIRS: &[&str] = &[
    r"\steam\", r"\epic games\launcher\", r"\electronic arts\", r"\ubisoft game launcher\",
    r"\rockstar games\launcher\", r"\rockstar games\social club\", r"\battle.net\", r"\windowsapps\",
    r"\gog galaxy\galaxyclient", r"\package cache\",
];
/// Folders that hold other games rather than being one ("D:\Games\GOG Games\<game>").
const LIBRARY_DIRS: &[&str] = &[
    "steamlibrary", "steamapps", "steam", "common", "epic games", "gog games", "gog galaxy", "ea games",
    "origin games", "ubisoft", "ubisoft game launcher", "xboxgames", "rockstar games", "battle.net", "amazon games",
    "games", "itch", "emulators",
];
/// Files and folders that only games ship: engines, Steam/GOG/Epic SDKs, video codecs, anti-cheat.
const GAME_FILES: &[&str] = &[
    "unityplayer.dll", "gameassembly.dll", "steam_api.dll", "steam_api64.dll", "galaxy.dll", "galaxy64.dll",
    "binkw32.dll", "binkw64.dll", "bink2w64.dll", "eossdk-win64-shipping.dll",
];
const GAME_DIRS: &[&str] = &["easyanticheat", "battleye"];

fn in_launcher_dir(path: &Path) -> bool {
    let key = format!("{}\\", folder_key(path));
    NOT_GAME_DIRS.iter().any(|d| key.contains(d))
}

/// A folder that holds programs or games rather than being one: a drive root, Windows, Program Files or a library
/// folder. Taken for a game, it would launch some exe deep inside and count every program in it as the game.
pub fn is_container(dir: &Path) -> bool {
    let name = file_name(dir).to_lowercase();
    let windows = std::env::var_os("SystemRoot").is_some_and(|w| folder_key(Path::new(&w)) == folder_key(dir));
    dir.parent().is_none()
        || windows
        || ["program files", "program files (x86)"].contains(&name.as_str())
        || LIBRARY_DIRS.contains(&name.as_str())
}

/// Whether a folder holds a game, judged by what's in it and one level down (installed programs are mostly apps).
fn looks_like_game(dir: &Path) -> bool {
    if dir.join(r"Engine\Binaries").is_dir() {
        return true; // Unreal Engine
    }
    let mut stack = vec![(dir.to_path_buf(), 0)];
    while let Some((d, depth)) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                if GAME_DIRS.contains(&name.as_str()) {
                    return true;
                }
                if depth == 0 {
                    stack.push((e.path(), 1));
                }
            } else if GAME_FILES.contains(&name.as_str()) || (name.starts_with("goggame-") && name.ends_with(".info")) {
                return true;
            }
        }
    }
    false
}

struct Taken(Vec<String>);

impl Taken {
    /// The folders of `claimed` games.
    fn of(claimed: &[Game]) -> Self {
        Taken(
            claimed.iter().flat_map(|g| std::iter::once(&g.dir).chain(&g.extra_dirs)).map(|d| folder_key(d)).collect(),
        )
    }

    /// The folder is a known game's folder or inside one.
    fn covers(&self, p: &Path) -> bool {
        let k = folder_key(p);
        self.0.iter().any(|c| k == *c || k.starts_with(&format!("{c}\\")))
    }

    /// A known game's folder is inside this one.
    fn inside(&self, p: &Path) -> bool {
        let k = format!("{}\\", folder_key(p));
        self.0.iter().any(|c| c.starts_with(&k))
    }
}

/// The games outside the `claimed` ones' folders: folders in `roots` (each drive's Games folder), installed
/// `programs` that look like games, and the exes Windows has seen run as games (`game_exes`).
pub fn games(claimed: &[Game], game_exes: &[PathBuf], roots: &[PathBuf], programs: &[Program]) -> Vec<Game> {
    let mut taken = Taken::of(claimed);
    let program_for =
        |dir: &Path| programs.iter().find(|p| p.folder.as_deref().is_some_and(|f| folder_key(f) == folder_key(dir)));
    let mut out = Vec::new();

    // 1. Folders in <drive>:\Games. A folder that holds other games (a store library, "GOG Games") is looked into.
    for dir in roots.iter().flat_map(|r| subdirs(r)) {
        let candidates = if is_container(&dir) || taken.inside(&dir) { subdirs(&dir) } else { vec![dir] };
        for dir in candidates {
            if taken.covers(&dir) || taken.inside(&dir) {
                continue;
            }
            let program = program_for(&dir);
            if let Some(g) = loose_game(&dir, game_exes, program) {
                taken.0.push(folder_key(&dir));
                out.push(g);
            }
        }
    }

    // 2. Installed programs that look like games (an installer put them anywhere, say C:\Program Files).
    for p in programs {
        let Some(dir) = &p.folder else { continue };
        if is_container(dir) || taken.covers(dir) || taken.inside(dir) || in_launcher_dir(dir) || !looks_like_game(dir)
        {
            continue;
        }
        if let Some(g) = loose_game(dir, game_exes, Some(p)) {
            taken.0.push(folder_key(dir));
            out.push(g);
        }
    }

    // 3. Exes Windows has seen run as games.
    for exe in game_exes {
        if taken.covers(exe) || skip_exe(exe) || in_launcher_dir(exe) {
            continue;
        }
        let dir = game_folder(exe);
        // An exe right in a container, or a folder that holds a known game, is no game folder of its own.
        if is_container(&dir) || taken.inside(&dir) {
            continue;
        }
        taken.0.push(folder_key(&dir));
        let name = program_for(&dir).map_or_else(|| prettify(&file_name(&dir)), |p| clean_name(&p.name));
        out.push(Game::new(format!("pc:{}", folder_key(&dir)), name, None, dir, Launch::Exe(exe.clone())));
    }
    out
}

/// The game folder an exe belongs to: its own folder, or above generic subfolders (bin, x64 and the like) so the game
/// is named after its own folder, but never a container.
pub fn game_folder(exe: &Path) -> PathBuf {
    let generic = |dir: &Path| {
        let name = file_name(dir).to_lowercase();
        ["bin", "bin64", "x64", "win64", "binaries", "retail", "game", "sp", "mp"].contains(&name.as_str())
    };
    let mut dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    while generic(&dir)
        && let Some(parent) = dir.parent().filter(|p| !is_container(p))
    {
        dir = parent.to_path_buf();
    }
    dir
}

/// What the game `exe` starts is called, as discovery names a game outside any store: after its game folder, or after
/// the exe itself when that folder is a container.
pub fn name_for(exe: &Path) -> String {
    let dir = game_folder(exe);
    let stem = || exe.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    prettify(&if is_container(&dir) { stem() } else { file_name(&dir) })
}

/// The installed programs `games` leaves out: mostly apps, and the odd game without the signs `looks_like_game`
/// knows. Each with its name and the exe that would start it, A to Z, for the player to add one by hand.
pub fn passed_over(games: &[Game], installed: &Installed) -> Vec<(String, PathBuf)> {
    let taken = Taken::of(games);
    let mut out: Vec<(String, PathBuf)> = installed
        .programs
        .iter()
        .filter_map(|p| {
            let dir = p.folder.as_deref()?;
            if is_container(dir) || taken.covers(dir) || taken.inside(dir) || in_launcher_dir(dir) {
                return None;
            }
            Some((clean_name(&p.name), pick_exe(dir, &installed.game_exes, p.exe.as_deref())?))
        })
        .collect();
    out.sort_by_cached_key(|(name, _)| name.to_lowercase());
    // A program listed in both the machine's and the account's list.
    out.dedup_by(|a, b| folder_key(&a.1) == folder_key(&b.1));
    out
}

/// A game outside any store: named by its GOG info file, its installed-programs entry, or its folder.
fn loose_game(dir: &Path, game_exes: &[PathBuf], program: Option<&Program>) -> Option<Game> {
    let gog = gog::info(dir);
    let hint = gog.as_ref().and_then(|(_, exe)| exe.as_deref()).or(program.and_then(|p| p.exe.as_deref()));
    let exe = pick_exe(dir, game_exes, hint)?;
    let name = match (gog, program) {
        (Some((name, _)), _) => name,
        (None, Some(p)) => clean_name(&p.name),
        (None, None) => prettify(&file_name(dir)),
    };
    Some(Game::new(format!("pc:{}", folder_key(dir)), name, None, dir.to_path_buf(), Launch::Exe(exe)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::Store;
    use std::fs;

    /// A fresh folder under the system temp folder (the tests run on Windows).
    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lamplit-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn file(p: PathBuf, size: usize) -> PathBuf {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, vec![0u8; size]).unwrap();
        p
    }

    fn found(games: &[Game]) -> Vec<(String, String)> {
        games
            .iter()
            .map(|g| {
                let exe = match &g.launch {
                    Launch::Exe(p) => file_name(p),
                    Launch::Uri(u) => u.clone(),
                };
                (g.name.clone(), exe)
            })
            .collect()
    }

    #[test]
    fn portable_folders_in_games() {
        let root = scratch("portable");
        let games_dir = root.join("Games");
        // The game, next to bigger exes that aren't it.
        file(games_dir.join(r"CoolGame2\CoolGame.exe"), 2000);
        file(games_dir.join(r"CoolGame2\unins000.exe"), 5000);
        file(games_dir.join(r"CoolGame2\CrashReporter.exe"), 6000);
        file(games_dir.join(r"CoolGame2\_CommonRedist\vcredist_x64.exe"), 9000);
        // Exe three folders down.
        file(games_dir.join(r"DeepGame\bin\x64\shipping\deep.exe"), 100);
        // No exe at all: not a game.
        file(games_dir.join(r"Soundtrack\track01.flac"), 100);
        let list = games(&[], &[], &[games_dir], &[]);
        assert_eq!(
            found(&list),
            vec![("Cool Game 2".into(), "CoolGame.exe".into()), ("Deep Game".into(), "deep.exe".into())]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn library_folders_hold_several_games() {
        let root = scratch("library");
        let games_dir = root.join("Games");
        file(games_dir.join(r"GOG Games\Alpha\alpha.exe"), 100);
        file(games_dir.join(r"GOG Games\Beta\beta.exe"), 100);
        // A Steam library inside Games: its game is Steam's, and the library itself is no game.
        let steam_game = games_dir.join(r"SteamLibrary\steamapps\common\Gamma");
        file(steam_game.join("gamma.exe"), 100);
        // A player's own folder that holds a store game and a game of its own.
        let epic_game = games_dir.join(r"Mine\Delta");
        file(epic_game.join("delta.exe"), 100);
        file(games_dir.join(r"Mine\Epsilon\epsilon.exe"), 100);
        let claimed = [
            Game::new(
                "steam:1".into(),
                "Gamma".into(),
                Some(Store::Steam),
                steam_game,
                Launch::Uri("steam://rungameid/1".into()),
            ),
            Game::new("epic:d".into(), "Delta".into(), Some(Store::Epic), epic_game, Launch::Uri("x".into())),
        ];
        let list = games(&claimed, &[], &[games_dir], &[]);
        assert_eq!(
            found(&list),
            vec![
                ("Alpha".into(), "alpha.exe".into()),
                ("Beta".into(), "beta.exe".into()),
                ("Epsilon".into(), "epsilon.exe".into())
            ]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn gog_info_names_the_game() {
        let root = scratch("goginfo");
        let games_dir = root.join("Games");
        let dir = games_dir.join("setup_witcher_3");
        file(dir.join(r"bin\x64\witcher3.exe"), 100);
        file(dir.join("bigger_tool.exe"), 9000);
        fs::write(
            dir.join("goggame-1495134320.info"),
            r#"{"gameId":"1495134320","name":"The Witcher 3: Wild Hunt","playTasks":[{"isPrimary":true,"path":"bin\\x64\\witcher3.exe"}]}"#,
        )
        .unwrap();
        let list = games(&[], &[], &[games_dir], &[]);
        assert_eq!(found(&list), vec![("The Witcher 3: Wild Hunt".into(), "witcher3.exe".into())]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn installed_programs_that_look_like_games() {
        let root = scratch("programs");
        let indie = root.join(r"Program Files\Indie Studio\Indie");
        let indie_exe = file(indie.join("Indie.exe"), 100);
        file(indie.join("UnityPlayer.dll"), 100);
        file(indie.join("bigger.exe"), 9000);
        let unreal = root.join(r"Program Files\Shooter");
        file(unreal.join(r"Engine\Binaries\ThirdParty\x.dll"), 10);
        file(unreal.join(r"Shooter\Binaries\Win64\Shooter-Win64-Shipping.exe"), 100);
        let tool = root.join(r"Program Files\Some Tool");
        let tool_exe = file(tool.join("tool.exe"), 100);
        let programs = vec![
            Program { name: "Indie Game™".into(), folder: Some(indie), exe: Some(indie_exe) },
            Program { name: "Shooter".into(), folder: Some(unreal), exe: None },
            Program { name: "Some Tool".into(), folder: Some(tool), exe: Some(tool_exe) },
            Program { name: "No folder".into(), folder: None, exe: None },
        ];
        let list = games(&[], &[], &[], &programs);
        assert_eq!(
            found(&list),
            vec![("Indie Game".into(), "Indie.exe".into()), ("Shooter".into(), "Shooter-Win64-Shipping.exe".into())]
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn programs_installed_into_a_container_are_no_game() {
        // An entry whose folder is Program Files itself, which holds an anti-cheat folder (a sign of a game) and
        // other programs' exes: taken for a game, every process in Program Files would count as it.
        let root = scratch("container");
        let program_files = root.join("Program Files (x86)");
        fs::create_dir_all(program_files.join("EasyAntiCheat")).unwrap();
        file(program_files.join(r"Vendor\Tool\tool.exe"), 100);
        let programs = vec![
            Program { name: "Vendor Runtime".into(), folder: Some(program_files), exe: None },
            Program { name: "Odd entry".into(), folder: Some(PathBuf::from(r"C:\")), exe: None },
        ];
        assert!(games(&[], &[], &[], &programs).is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn game_exes_never_climb_into_a_container() {
        let root = scratch("climb");
        // "Game" is a generic folder name, but its parent is a library folder: the game is that Game folder.
        let in_library = file(root.join(r"Games\Game\run.exe"), 100);
        // Right in a library folder: no folder of its own.
        let loose_in_library = file(root.join(r"Games\stray.exe"), 100);
        // Climbing out of bin reaches a folder that holds a store game: no folder of its own either.
        let next_to_store_game = file(root.join(r"Mine\bin\tool.exe"), 100);
        let other = root.join(r"Mine\Other");
        let claimed = [Game::new("epic:o".into(), "O".into(), Some(Store::Epic), other, Launch::Uri("x".into()))];
        let list = games(&claimed, &[in_library, loose_in_library, next_to_store_game], &[], &[]);
        assert_eq!(found(&list), vec![("Game".into(), "run.exe".into())]);
        assert_eq!(folder_key(&list[0].dir), folder_key(&root.join(r"Games\Game")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn programs_discovery_passed_over_can_be_added_by_hand() {
        let root = scratch("passed-over");
        let tool = root.join(r"Program Files\Some Tool");
        let tool_exe = file(tool.join("tool.exe"), 100);
        // An emulator without any sign of a game, whose uninstaller is its icon.
        let emu = root.join(r"Emulators2\Emu");
        file(emu.join("unins000.exe"), 9000);
        let emu_exe = file(emu.join(r"bin\emu.exe"), 100);
        let claimed_dir = root.join(r"Program Files\Claimed");
        file(claimed_dir.join("claimed.exe"), 100);
        let cache = root.join(r"ProgramData\Package Cache\{1}");
        let cached_exe = file(cache.join("thing.exe"), 100);
        let programs = vec![
            Program { name: "Some Tool®".into(), folder: Some(tool), exe: Some(tool_exe.clone()) },
            Program { name: "emu".into(), folder: Some(emu.clone()), exe: Some(emu.join("unins000.exe")) },
            Program { name: "Claimed".into(), folder: Some(claimed_dir.clone()), exe: None },
            Program { name: "Runtime".into(), folder: Some(cache), exe: Some(cached_exe) },
            Program { name: "Odd entry".into(), folder: Some(PathBuf::from(r"C:\")), exe: None },
        ];
        let claimed = [Game::new("pc:c".into(), "C".into(), None, claimed_dir, Launch::Exe(PathBuf::new()))];
        let installed = Installed { drives: Vec::new(), programs, game_exes: Vec::new() };
        assert_eq!(passed_over(&claimed, &installed), vec![("emu".into(), emu_exe), ("Some Tool".into(), tool_exe)]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn exes_are_named_after_their_game_folder() {
        assert_eq!(game_folder(Path::new(r"D:\Stuff\CoolGame2\bin\x64\cool.exe")), Path::new(r"D:\Stuff\CoolGame2"));
        assert_eq!(name_for(Path::new(r"D:\Stuff\CoolGame2\bin\x64\cool.exe")), "Cool Game 2");
        // Right in a library folder: named after the exe.
        assert_eq!(game_folder(Path::new(r"D:\Games\bin\tetris_classic.exe")), Path::new(r"D:\Games\bin"));
        assert_eq!(name_for(Path::new(r"D:\Games\SuperTetris.exe")), "Super Tetris");
    }

    #[test]
    fn exes_windows_saw_run_as_games() {
        let root = scratch("game-exes");
        let exe = file(root.join(r"Other\MyGame\Binaries\Win64\MyGame.exe"), 100);
        let steam_exe = file(root.join(r"Steam\steam.exe"), 100);
        let inside_claimed = file(root.join(r"Claimed\x.exe"), 100);
        let claimed =
            [Game::new("epic:c".into(), "C".into(), Some(Store::Epic), root.join("Claimed"), Launch::Uri("x".into()))];
        let list = games(&claimed, &[exe, steam_exe, inside_claimed], &[], &[]);
        assert_eq!(found(&list), vec![("My Game".into(), "MyGame.exe".into())]);
        assert_eq!(folder_key(&list[0].dir), folder_key(&root.join(r"Other\MyGame")));
        let _ = fs::remove_dir_all(root);
    }
}
