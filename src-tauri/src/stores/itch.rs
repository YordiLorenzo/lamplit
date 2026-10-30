// itch.io: the games the itch app installed, from its database (butler.db, kept by butler, the app's helper). They
// are DRM-free and start as the app would start them: the action the game's manifest names, else the exe the app
// found. So the app itself never has to run, except for a game it runs in its sandbox: that one goes to the app's
// own launcher, never straight to its exe.

use super::installed::skip_exe;
use super::names::{clean_name, prettify};
use super::{Store, sqlite};
use crate::files::{file_name, inside, local_app_data, on_a_drive, read_text};
use crate::library::{Game, Launch};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use winreg::RegKey;
use winreg::enums::HKEY_CURRENT_USER;

/// The app's installer, itch-setup, puts it in the folder its uninstall entry names (`%LOCALAPPDATA%\itch` unless the
/// player chose another), with each version in its own folder and the current one named in state.json. It leaves a
/// copy of itself there too, which also starts games (see `launch`).
fn base() -> PathBuf {
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\itch")
        .and_then(|k| k.get_value::<String, _>("InstallLocation"))
        .map_or_else(|_| local_app_data().join("itch"), PathBuf::from)
}

pub fn exe() -> Option<PathBuf> {
    app_exe(&base())
}

fn app_exe(base: &Path) -> Option<PathBuf> {
    let state: Value = serde_json::from_str(&read_text(&base.join("state.json"))?).ok()?;
    inside(base, &format!(r"app-{}\itch.exe", state["current"].as_str()?))
}

pub fn games() -> Vec<Game> {
    let Some(roaming) = std::env::var_os("APPDATA") else { return Vec::new() };
    let user_data = Path::new(&roaming).join("itch");
    let Some(db) = sqlite::Db::open(&user_data.join(r"db\butler.db")) else { return Vec::new() };
    let app = App {
        isolate_apps: isolate_apps(&user_data.join("preferences.json")),
        setup: base().join("itch-setup.exe"),
        // The app's prerequisites folder, which butler marks each prerequisite installed in.
        prereqs: user_data.join("prereqs"),
    };
    let mut out: Vec<Game> = Vec::new();
    for cave in caves(&db) {
        let id = format!("itch:{}", cave.game_id);
        let name = cave.title.as_deref().map_or_else(|| prettify(&file_name(&cave.dir)), clean_name);
        if !on_a_drive(&cave.dir) || !cave.dir.is_dir() {
            log::info!("discovery itch: {name} skipped, {} is missing", cave.dir.display());
            continue;
        }
        let Some((start, exe_names)) = launch(&cave, &app) else {
            log::info!("discovery itch: {name} skipped, it has no Windows exe (an HTML or Java game, say)");
            continue;
        };
        let mut game = Game::new(id, name, Some(Store::Itch), cave.dir, start);
        game.exe_names = exe_names;
        out.push(game);
    }
    out
}

/// An install (butler calls it a cave).
#[derive(Debug, PartialEq)]
struct Cave {
    game_id: i64,
    title: Option<String>,
    dir: PathBuf,
    /// The Windows exes the app found in the folder, relative to it, best first.
    exes: Vec<String>,
    /// What the player picked to launch in the app, when a game has several: an action's name or a path.
    target: Option<String>,
    /// The game's own sandbox setting in the app, when the player set one.
    sandbox: Option<bool>,
    /// butler has run the game from this install (it records the run once the game ends, `local_last_run_at`).
    ran: bool,
    /// The player set a command template in the app for this game (arguments, environment variables or a wrapper
    /// around its exe, `commandTemplate`), which butler applies when it starts the game.
    template: bool,
}

/// The installs of games, from the tables caves, games and install_locations: one per game. itch.io also sells tools,
/// assets, soundtracks and books, and the games table says which each is.
///
/// A game installed twice (two of its downloads) has two caves. `itch-setup --run-game` names only the game, and butler
/// then launches the game's most recently used cave (cmd/launchcmd resolveCave), so Lamplit takes that one too, for
/// every launch: the folder it watches is then the one the game runs from. Should that cave be one Lamplit can't
/// start, the game is left out rather than started from another install.
fn caves(db: &sqlite::Db) -> Vec<Cave> {
    let (Some(caves), Some(games), Some(locations)) =
        (db.rows("caves"), db.rows("games"), db.rows("install_locations"))
    else {
        return Vec::new();
    };
    let mut caves: Vec<(&sqlite::Row, Option<OffsetDateTime>)> = caves
        .iter()
        .map(|c| (c, used(["local_last_run_at", "last_touched_at", "installed_at"].map(|t| c.text(t)))))
        .collect();
    // Newest first, and among equals the database's order, as butler's stable sort leaves them.
    caves.sort_by_key(|(_, used)| std::cmp::Reverse(*used));
    let mut seen = HashSet::new();
    caves
        .into_iter()
        .filter_map(|(c, _)| {
            let game_id = c.int("game_id")?;
            if !seen.insert(game_id) {
                return None;
            }
            let game = games.iter().find(|g| g.int("id") == Some(game_id));
            if game.and_then(|g| g.text("classification")).is_some_and(|kind| kind != "game") {
                return None;
            }
            // A folder of the player's choosing, or one in an install location the app manages.
            let dir = if let Some(custom) = c.text("custom_install_folder").filter(|f| !f.is_empty()) {
                PathBuf::from(custom)
            } else {
                let location = locations.iter().find(|l| l.text("id") == c.text("install_location_id"))?;
                inside(Path::new(location.text("path")?), c.text("install_folder_name")?)?
            };
            let verdict: Value = serde_json::from_str(c.text("verdict")?).ok()?;
            let title = game.and_then(|g| g.text("title")).map(str::to_string);
            let settings: Value = c.text("settings").and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
            let target = settings["launchTarget"].as_str().filter(|t| !t.is_empty()).map(str::to_string);
            let sandbox = settings["sandbox"].as_bool();
            let ran = c.text("local_last_run_at").is_some();
            let template = settings["commandTemplate"].as_str().is_some_and(|t| !t.trim().is_empty());
            Some(Cave { game_id, title, dir, exes: windows_exes(&verdict), target, sandbox, ran, template })
        })
        .collect()
}

/// When a cave was last used, as butler orders caves (caveFreshness): its last local run, else when the app last saw
/// it played or touched, else when it was installed; the first of these that is set counts, not the latest. butler
/// keeps them as RFC 3339 text, which a different time zone or number of decimals would sort wrongly as text.
fn used(times: [Option<&str>; 3]) -> Option<OffsetDateTime> {
    times.into_iter().flatten().find_map(|t| OffsetDateTime::parse(t, &Rfc3339).ok())
}

/// The native Windows exes in an install's verdict, the app's scan of the folder: nearest the top of the folder
/// first, then the largest, with crash reporters, installers and the like at the end.
fn windows_exes(verdict: &Value) -> Vec<String> {
    let mut list: Vec<(bool, u64, i64, String)> = verdict["candidates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["flavor"] == "windows")
        .filter_map(|c| {
            let path = c["path"].as_str()?.replace('/', "\\");
            Some((skip_exe(Path::new(&path)), c["depth"].as_u64().unwrap_or(0), c["size"].as_i64().unwrap_or(0), path))
        })
        .collect();
    list.sort_by(|a, b| (a.0, a.1).cmp(&(b.0, b.1)).then(b.2.cmp(&a.2)));
    list.into_iter().map(|(.., path)| path).collect()
}

/// What Lamplit knows of the itch app itself.
struct App {
    /// The app's preference to run every game in its sandbox.
    isolate_apps: bool,
    /// The app's launcher, which also starts games: `itch-setup --run-game` (itch 26.20 and later).
    setup: PathBuf,
    /// The folder butler installs prerequisites from, and marks each one installed in (`<name>\.installed`).
    prereqs: PathBuf,
}

/// What starts a game, and the names of its exes when Lamplit can know the game only by them. The game's own start
/// is picked as butler (the app's helper) picks it: an action from the game's manifest that runs on Windows, else the
/// exes the app found; of several, the one the player picked in the app, else the action named "play", else the
/// first (the app itself would ask the player).
///
/// A game starts from that exe unless it needs something only the app gives it. Then it goes to the app's launcher,
/// which starts it through butler as the app would:
/// - The sandbox, a Windows account of its own with less access than the player's: when the game's own setting says
///   so, or, without one, when the app's preference or the manifest's action asks for it (perform-launch.ts in the
///   app). Its processes then belong to the sandbox's account, so Lamplit also knows them by name.
/// - An itch.io API key for the session (`ITCHIO_API_KEY`), which the manifest's action can ask for.
/// - Prerequisites (VC++, .NET, DirectX and the like), which butler installs before every start that needs them:
///   those the manifest names until each is marked installed, and before the first start, those it finds from the
///   DLLs the game's exes import, and Unreal Engine's (launchers/native/prereqs.go). butler records a run only after
///   all that, so a game it has run from this install has had them.
/// - The command template the player set for the game in the app, which butler applies to the start.
fn launch(cave: &Cave, app: &App) -> Option<(Launch, Vec<String>)> {
    let scanned = || {
        let picked = cave.target.as_deref().and_then(|t| cave.exes.iter().find(|e| same_path(e, t)));
        let exe = picked.into_iter().chain(&cave.exes).filter_map(|rel| inside(&cave.dir, rel)).find(|p| p.is_file());
        exe.map(|exe| Start { exe, args: Vec::new(), sandbox: false, api_key: false, prereqs: Vec::new() })
    };
    let start = manifest_action(&cave.dir, cave.target.as_deref()).or_else(scanned)?;
    let installed = |name: &String| inside(&app.prereqs, name).is_some_and(|d| d.join(".installed").is_file());
    let prereqs = !cave.ran || !start.prereqs.iter().all(installed);
    if prereqs || cave.template || start.api_key || cave.sandbox.unwrap_or(app.isolate_apps || start.sandbox) {
        let run = format!("--appname itch --run-game {}", cave.game_id);
        return Some((Launch::ExeArgs(app.setup.clone(), run), vec![file_name(&start.exe).to_lowercase()]));
    }
    let launch = if start.args.is_empty() {
        Launch::Exe(start.exe)
    } else {
        Launch::ExeArgs(start.exe, command_line(&start.args))
    };
    Some((launch, Vec::new()))
}

/// A game's own start: its exe and arguments, and what it asks of the app.
struct Start {
    exe: PathBuf,
    args: Vec<String>,
    /// The manifest's action opts into the sandbox.
    sandbox: bool,
    /// The manifest's action asks for an itch.io API key (`scope`), which only the app hands out.
    api_key: bool,
    /// The prerequisites the manifest names, by their names in butler's list.
    prereqs: Vec<String>,
}

/// Whether the app's preference to run every game in its sandbox is on (preferences.json in the app's data folder).
fn isolate_apps(preferences: &Path) -> bool {
    let prefs: Option<Value> = read_text(preferences).and_then(|t| serde_json::from_str(&t).ok());
    prefs.is_some_and(|p| p["isolateApps"].as_bool() == Some(true))
}

/// A game's `.itch.toml`, at the top of its folder (https://itch.io/docs/itch/integrating/manifest.html). Lamplit
/// reads the actions' name, path, args, platform, sandbox opt-in and API scope, and the prerequisites' names; the rest
/// (console window, translated names) is the app's.
#[derive(Deserialize)]
struct Manifest {
    #[serde(default)]
    actions: Vec<Action>,
    #[serde(default)]
    prereqs: Vec<Prereq>,
}

#[derive(Deserialize)]
struct Prereq {
    name: String,
}

#[derive(Deserialize)]
struct Action {
    #[serde(default)]
    name: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    args: Vec<String>,
    platform: Option<String>,
    #[serde(default)]
    sandbox: bool,
    /// `profile:me` asks the app for an API key; butler refuses any other scope.
    #[serde(default)]
    scope: String,
}

/// The start the manifest's action for this game names, if the game ships a manifest with an action that runs on
/// Windows: one with no platform or `windows`, whose path (`{{EXT}}` standing for `.exe`) is an exe in the game's
/// folder. URLs, folders and other platforms' files are left out, as butler leaves them out on Windows.
fn manifest_action(dir: &Path, picked: Option<&str>) -> Option<Start> {
    let text = read_text(&dir.join(".itch.toml"))?;
    let manifest: Manifest = toml::from_str(&text)
        .map_err(|e| log::info!("discovery itch: {} has a manifest Lamplit can't read: {e}", dir.display()))
        .ok()?;
    let actions: Vec<(&Action, String, PathBuf)> = manifest
        .actions
        .iter()
        .filter(|a| a.platform.as_deref().is_none_or(|p| p == "windows"))
        .filter_map(|a| {
            let path = a.path.replacen("{{EXT}}", ".exe", 1);
            let exe = inside(dir, &path.replace('/', "\\"))?;
            (exe.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")) && exe.is_file()).then_some((a, path, exe))
        })
        .collect();
    let named = |name: &str| actions.iter().find(|(a, ..)| a.name == name);
    // A pick by path may spell `{{EXT}}` out or not.
    let at = |t: &str| actions.iter().find(|(a, path, _)| same_path(&a.path, t) || same_path(path, t));
    let (action, _, exe) =
        picked.and_then(|t| named(t).or_else(|| at(t))).or_else(|| named("play")).or(actions.first())?;
    Some(Start {
        exe: exe.clone(),
        args: action.args.clone(),
        sandbox: action.sandbox,
        api_key: !action.scope.is_empty(),
        prereqs: manifest.prereqs.iter().map(|p| p.name.clone()).collect(),
    })
}

/// Two paths relative to a game's folder, in either slash and with or without `./`, are the same.
fn same_path(a: &str, b: &str) -> bool {
    let plain = |p: &str| p.replace('\\', "/").trim_start_matches("./").to_lowercase();
    plain(a) == plain(b)
}

/// Arguments as one Windows command line, quoted so the program splits it back the same way (CommandLineToArgvW and
/// the C runtime: backslashes count double only before a quote).
fn command_line(args: &[String]) -> String {
    let quote = |arg: &String| {
        if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0B', '"']) {
            return arg.clone();
        }
        let mut out = String::from('"');
        let mut slashes = 0;
        for c in arg.chars() {
            if c == '\\' {
                slashes += 1;
                continue;
            }
            let n = if c == '"' { slashes * 2 + 1 } else { slashes };
            out.extend(std::iter::repeat_n('\\', n));
            out.push(c);
            slashes = 0;
        }
        out.extend(std::iter::repeat_n('\\', slashes * 2));
        out.push('"');
        out
    };
    args.iter().map(quote).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::sqlite::fixtures::{BUTLER, BUTLER_WAL};
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lamplit-test-itch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn installs_from_the_apps_database() {
        let dir = scratch("db");
        fs::write(dir.join("butler.db"), BUTLER).unwrap();
        fs::write(dir.join("butler.db-wal"), BUTLER_WAL).unwrap();
        let db = sqlite::Db::open(&dir.join("butler.db")).unwrap();
        let apps = r"C:\Users\player\AppData\Roaming\itch\apps";
        let cave = |game_id, title: &str, dir: &str, exes: &[&str]| Cave {
            game_id,
            title: Some(title.into()),
            dir: PathBuf::from(dir),
            exes: exes.iter().map(|e| (*e).to_string()).collect(),
            target: None,
            sandbox: None,
            ran: false,
            template: false,
        };
        // Not the tool. The HTML game is there, with no exe to start (games() leaves it out), and so is the one on a
        // share (games() never follows it).
        assert_eq!(
            caves(&db),
            vec![
                // Of Fennel's two downloads, the one used last, which butler launches for the game.
                // butler has run it from there.
                Cave { ran: true, ..cave(1001, "Fennel", &format!(r"{apps}\fennel-beta"), &["FennelBeta.exe"]) },
                cave(1003, "Web Toy", &format!(r"{apps}\web-toy"), &[]),
                // The player picked the play action in the app, switched the sandbox off for it, and set a command
                // template.
                Cave {
                    target: Some("play".into()),
                    sandbox: Some(false),
                    template: true,
                    ..cave(1004, "Clover™", r"D:\Games\Clover", &[r"bin\clover.exe"])
                },
                cave(1005, "Share Game", r"\\nas\itch\share-game", &["share.exe"]),
            ]
        );
        // The first download's scan: the game's exe first, the bigger crash handler last.
        let rows = db.rows("caves").unwrap();
        let first = rows.iter().find(|c| c.text("id") == Some("cave-fennel")).unwrap();
        let verdict: Value = serde_json::from_str(first.text("verdict").unwrap()).unwrap();
        assert_eq!(windows_exes(&verdict), ["Fennel.exe", r"tools\editor.exe", "UnityCrashHandler64.exe"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn when_a_cave_was_used() {
        let at = |t: &str| OffsetDateTime::parse(t, &Rfc3339).unwrap();
        // The first time that is set counts, also when a later one is newer.
        assert_eq!(
            used([None, Some("2026-10-01T14:00:00+05:00"), Some("2026-10-25T09:00:00Z")]),
            Some(at("2026-10-01T09:00:00Z"))
        );
        // As times, not as text: 10:30 UTC is after 14:00 in UTC+5.
        assert!(
            used([Some("2026-10-01T10:30:00.25Z"), None, None]) > used([Some("2026-10-01T14:00:00+05:00"), None, None])
        );
        // A time that doesn't read counts as not set, as butler reads it.
        assert_eq!(used([Some("yesterday"), None, Some("2026-03-01T10:00:00Z")]), Some(at("2026-03-01T10:00:00Z")));
        assert_eq!(used([None, None, None]), None);
    }

    /// A game's folder with these files, and its install as the app's database describes it.
    fn install(name: &str, files: &[&str], exes: &[&str]) -> (PathBuf, impl Fn(Option<&str>) -> Cave) {
        let dir = scratch(name);
        for f in files {
            let path = dir.join(f);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, [0u8; 16]).unwrap();
        }
        let exes: Vec<String> = exes.iter().map(|e| (*e).to_string()).collect();
        let cave_dir = dir.clone();
        let cave = move |target: Option<&str>| Cave {
            game_id: 1,
            title: None,
            dir: cave_dir.clone(),
            exes: exes.clone(),
            target: target.map(str::to_string),
            sandbox: None,
            // Run by butler before, so its prerequisites are in.
            ran: true,
            template: false,
        };
        (dir, cave)
    }

    /// The app, with its preference to run every game in its sandbox, and its prerequisites folder (by default one
    /// with nothing marked installed).
    fn app(isolate_apps: bool) -> App {
        App {
            isolate_apps,
            setup: PathBuf::from(r"C:\Users\player\AppData\Local\itch\itch-setup.exe"),
            prereqs: PathBuf::from(r"C:\Users\player\AppData\Roaming\itch\prereqs"),
        }
    }

    /// How a game that needs nothing of the app starts.
    fn direct(cave: &Cave) -> Option<Launch> {
        launch(cave, &app(false)).map(|(launch, _)| launch)
    }

    /// The app's launcher starting game 1.
    fn handed() -> (Launch, Vec<String>) {
        let run = "--appname itch --run-game 1".to_string();
        (Launch::ExeArgs(app(false).setup, run), vec!["game.exe".to_string()])
    }

    #[test]
    fn starts_what_the_manifest_names() {
        // The app's scan puts the biggest exe first, which isn't the game; the manifest names the game and how to
        // start it.
        let (dir, cave) = install(
            "manifest",
            &["Launcher.exe", r"bin\Game.exe", r"bin\editor.exe", r"tools\big.exe", r"docs\manual.html"],
            &[r"tools\big.exe", "Launcher.exe", r"bin\Game.exe"],
        );
        let manifest = r#"
[[actions]]
name = "editor"
path = "bin/editor{{EXT}}"

[[actions]]
name = "play"
path = "bin/Game.exe"
platform = "windows"
args = ["--fullscreen", "--save", "C:\\Saved Games\\Fennel\\", 'say "hi"']

[[actions.locales.fr]]
name = "Jouer"

[[actions]]
name = "play"
path = "Game.x86_64"
platform = "linux"

[[actions]]
name = "forums"
path = "https://example.itch.io/fennel/community"

[[actions]]
name = "manual"
path = "docs/"
"#;
        let write = |text: &str| fs::write(dir.join(".itch.toml"), text).unwrap();
        write(manifest);
        let play = Launch::ExeArgs(
            dir.join(r"bin\Game.exe"),
            r#"--fullscreen --save "C:\Saved Games\Fennel\\" "say \"hi\"""#.into(),
        );
        assert_eq!(direct(&cave(None)), Some(play.clone()));
        // What the player picked in the app, by action name or by path; a pick an update left behind counts for
        // nothing.
        let editor = Launch::Exe(dir.join(r"bin\editor.exe"));
        assert_eq!(direct(&cave(Some("editor"))), Some(editor.clone()));
        assert_eq!(direct(&cave(Some("./bin/editor.exe"))), Some(editor.clone()));
        assert_eq!(direct(&cave(Some("Old.exe"))), Some(play));
        // Without a play action for Windows, the first action that has an exe.
        write(
            "[[actions]]\nname = 'web'\npath = 'https://example.itch.io'\n[[actions]]\nname = 'editor'\npath = 'bin/editor.exe'",
        );
        assert_eq!(direct(&cave(None)), Some(editor));
        // A manifest with nothing for Windows, or one that doesn't read, leaves the exes the app found.
        let found = Some(Launch::Exe(dir.join(r"tools\big.exe")));
        write("[[actions]]\nname = 'play'\npath = 'Game.x86_64'\nplatform = 'linux'");
        assert_eq!(direct(&cave(None)), found);
        write("[[actions]\nname = ");
        assert_eq!(direct(&cave(None)), found);
        // No manifest: the exes the app found, the player's pick among them first.
        fs::remove_file(dir.join(".itch.toml")).unwrap();
        assert_eq!(direct(&cave(None)), found);
        assert_eq!(direct(&cave(Some("Launcher.exe"))), Some(Launch::Exe(dir.join("Launcher.exe"))));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_game_in_the_sandbox_goes_to_the_apps_launcher() {
        let (dir, cave) = install("sandbox", &[r"bin\Game.exe"], &[r"bin\Game.exe"]);
        let handed = Some(handed());
        let from_exe = Some((Launch::Exe(dir.join(r"bin\Game.exe")), Vec::new()));
        // The app's preference to run every game in the sandbox.
        assert_eq!(launch(&cave(None), &app(true)), handed);
        assert_eq!(launch(&cave(None), &app(false)), from_exe);
        // The manifest's action asks for it.
        fs::write(dir.join(".itch.toml"), "[[actions]]\nname = 'play'\npath = 'bin/Game.exe'\nsandbox = true").unwrap();
        assert_eq!(launch(&cave(None), &app(false)), handed);
        // The game's own setting in the app wins either way, as it does in the app.
        let set = |sandbox| Cave { sandbox: Some(sandbox), ..cave(None) };
        assert_eq!(launch(&set(false), &app(true)), from_exe);
        fs::remove_file(dir.join(".itch.toml")).unwrap();
        assert_eq!(launch(&set(true), &app(false)), handed);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_game_that_asks_for_an_api_key_goes_to_the_apps_launcher() {
        let (dir, cave) = install("apikey", &[r"bin\Game.exe"], &[r"bin\Game.exe"]);
        let handed = Some(handed());
        let manifest = "[[actions]]\nname = 'play'\npath = 'bin/Game.exe'\nargs = ['--online']\n";
        fs::write(dir.join(".itch.toml"), manifest).unwrap();
        let from_exe = Some((Launch::ExeArgs(dir.join(r"bin\Game.exe"), "--online".into()), Vec::new()));
        assert_eq!(launch(&cave(None), &app(false)), from_exe);
        // Only the app hands out the key, also to a game kept out of the sandbox.
        fs::write(dir.join(".itch.toml"), format!("{manifest}scope = 'profile:me'\n")).unwrap();
        assert_eq!(launch(&cave(None), &app(false)), handed);
        assert_eq!(launch(&Cave { sandbox: Some(false), ..cave(None) }, &app(false)), handed);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn prerequisites_go_through_the_app_until_installed() {
        let (dir, cave) = install("prereqs", &[r"bin\Game.exe"], &[r"bin\Game.exe"]);
        let app = App { prereqs: dir.join("prereqs"), ..app(false) };
        let from_exe = Some((Launch::Exe(dir.join(r"bin\Game.exe")), Vec::new()));
        let manifest = "[[actions]]\nname = 'play'\npath = 'bin/Game.exe'\n\n\
            [[prereqs]]\nname = 'vcredist-2015-x64'\n\n[[prereqs]]\nname = 'net-4.8'\n";
        fs::write(dir.join(".itch.toml"), manifest).unwrap();
        let mark = |name: &str| {
            fs::create_dir_all(dir.join(r"prereqs").join(name)).unwrap();
            fs::write(dir.join(r"prereqs").join(name).join(".installed"), "Installed on 2026-10-27").unwrap();
        };
        // Named in the manifest and not yet marked installed: butler installs them first.
        assert_eq!(launch(&cave(None), &app), Some(handed()));
        mark("vcredist-2015-x64");
        assert_eq!(launch(&cave(None), &app), Some(handed()));
        mark("net-4.8");
        assert_eq!(launch(&cave(None), &app), from_exe);
        // A name that would lead out of the prerequisites folder is never taken for installed.
        fs::write(
            dir.join(".itch.toml"),
            "[[actions]]\nname = 'play'\npath = 'bin/Game.exe'\n[[prereqs]]\nname = '../prereqs/net-4.8'\n",
        )
        .unwrap();
        assert_eq!(launch(&cave(None), &app), Some(handed()));
        // Without a manifest, butler finds them from the game's DLLs, which only it can: an install it has never run
        // goes to it, once.
        fs::remove_file(dir.join(".itch.toml")).unwrap();
        assert_eq!(launch(&Cave { ran: false, ..cave(None) }, &app), Some(handed()));
        assert_eq!(launch(&cave(None), &app), from_exe);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_game_with_a_command_template_goes_to_the_apps_launcher() {
        let (dir, cave) = install("template", &[r"bin\Game.exe"], &[r"bin\Game.exe"]);
        assert_eq!(launch(&cave(None), &app(false)), Some((Launch::Exe(dir.join(r"bin\Game.exe")), Vec::new())));
        // butler applies the template (say `%command% --fullscreen`) when it starts the game.
        assert_eq!(launch(&Cave { template: true, ..cave(None) }, &app(false)), Some(handed()));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_apps_sandbox_preference() {
        let dir = scratch("prefs");
        let prefs = dir.join("preferences.json");
        assert!(!isolate_apps(&prefs));
        fs::write(&prefs, r#"{"isolateApps":true,"openAtLogin":false}"#).unwrap();
        assert!(isolate_apps(&prefs));
        fs::write(&prefs, r#"{"isolateApps":false}"#).unwrap();
        assert!(!isolate_apps(&prefs));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_manifest_path_stays_in_the_games_folder() {
        let (dir, cave) = install("outside", &["Game.exe"], &["Game.exe"]);
        fs::write(dir.join(".itch.toml"), "[[actions]]\nname = 'play'\npath = '../other/Game.exe'").unwrap();
        assert_eq!(direct(&cave(None)), Some(Launch::Exe(dir.join("Game.exe"))));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn command_lines() {
        let line = |args: &[&str]| command_line(&args.iter().map(|a| (*a).to_string()).collect::<Vec<_>>());
        assert_eq!(line(&["-w", "1920"]), "-w 1920");
        assert_eq!(line(&["a", ""]), r#"a """#);
        assert_eq!(line(&[r"C:\Program Files\x"]), r#""C:\Program Files\x""#);
        // Backslashes count double only before a quote.
        assert_eq!(line(&[r#"a\"b"#]), r#""a\\\"b""#);
        assert_eq!(line(&[r"dir with space\"]), r#""dir with space\\""#);
    }

    #[test]
    fn the_app_in_its_current_version_folder() {
        let base = scratch("app");
        fs::write(base.join("state.json"), r#"{"current":"26.1.9","ready":""}"#).unwrap();
        assert_eq!(app_exe(&base), Some(base.join(r"app-26.1.9\itch.exe")));
        fs::write(base.join("state.json"), r#"{"current":"..\\..\\elsewhere"}"#).unwrap();
        assert_eq!(app_exe(&base), None);
        fs::remove_dir_all(&base).unwrap();
    }
}
