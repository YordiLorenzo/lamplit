// Battle.net: its games, from product.db (the list Battle.net's agent keeps of every product it installed); how one
// starts (Battle.net is told to launch it, as Playnite, GOG Galaxy and Lutris do); and whether Battle.net is signed
// in, from the log it writes each time it starts.

use super::names::{clean_name, prettify};
use super::{Account, Store, machine_value, proto};
use crate::files::{file_name, local_app_data, on_a_drive, read_text};
use crate::library::{Game, Launch};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use winreg::RegKey;
use winreg::enums::HKEY_LOCAL_MACHINE;

const UNINSTALL: &str = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";

/// Battle.net's installer records its folder in the installed-programs list, under the key `Battle.net`.
pub fn exe() -> Option<PathBuf> {
    machine_value(&format!(r"{UNINSTALL}\Battle.net"), "InstallLocation").map(|d| Path::new(&d).join("Battle.net.exe"))
}

/// One product in product.db.
#[derive(Debug, PartialEq)]
struct Install {
    /// The install's id, which Battle.net's uninstall entries (`--uid=`) and `--game=` use: "prometheus".
    uid: String,
    /// The product's code on Blizzard's servers: "pro".
    product: String,
    dir: PathBuf,
    installed: bool,
}

/// product.db is a protobuf message: field 1 repeats one ProductInstall per product (uid 1, product code 2, settings
/// 3 with the install path in 1, cached state 4 whose base state 1 has `installed` in 1). The layout is the one GOG
/// Galaxy's Battle.net plugin decodes (product_db.proto), checked against a real product.db.
fn installs(db: &[u8]) -> Vec<Install> {
    proto::fields(db)
        .filter_map(|(n, f)| match f {
            proto::Field::Bytes(product) if n == 1 => Some(product),
            _ => None,
        })
        .map(|p| {
            let path = proto::bytes(p, 3).and_then(|settings| proto::string(settings, 1)).unwrap_or_default();
            let state = proto::bytes(p, 4).and_then(|cached| proto::bytes(cached, 1)).unwrap_or_default();
            Install {
                uid: proto::string(p, 1).unwrap_or_default(),
                product: proto::string(p, 2).unwrap_or_default(),
                // Battle.net writes the path with forward slashes: "C:/Program Files (x86)/Overwatch".
                dir: PathBuf::from(path.replace('/', "\\")),
                installed: proto::varint_field(state, 1) == Some(1),
            }
        })
        .collect()
}

/// The codes `Battle.net.exe --exec="launch <code>"` takes, by product code or uid. Battle.net keeps them nowhere on
/// disk, so every launcher that starts Battle.net games carries a list like this one. From Playnite's
/// BattleNetLibrary (BattleNetGames.cs) and Lutris (services/battlenet.py).
const LAUNCH_CODES: &[(&str, &[&str])] = &[
    ("WoW", &["wow"]),
    ("WoW_wow_classic", &["wow_classic"]),
    ("WoW_wow_classic_era", &["wow_classic_era"]),
    ("D1", &["d1"]),
    ("D3", &["d3", "diablo3"]),
    ("D3CN", &["d3cn"]),
    ("OSI", &["osi"]),
    ("Fen", &["fenris"]),
    ("ANBS", &["anbs"]),
    ("S1", &["s1"]),
    ("S2", &["s2"]),
    ("W1", &["w1"]),
    ("W1R", &["w1r"]),
    ("W2", &["w2"]),
    ("W2BN", &["w2bn"]),
    ("W2R", &["w2r"]),
    ("W3", &["w3"]),
    ("GRY", &["gryphon"]),
    ("WTCG", &["hsb", "hs_beta"]),
    ("Hero", &["hero", "heroes"]),
    ("Pro", &["pro", "prometheus"]),
    ("RTRO", &["rtro"]),
    ("VIPR", &["viper"]),
    ("ODIN", &["odin"]),
    ("LAZR", &["lazarus"]),
    ("ZEUS", &["zeus"]),
    ("FORE", &["fore"]),
    ("AUKS", &["auks"]),
    ("PNTA", &["pinta"]),
    ("WLBY", &["wlby"]),
    ("ARIS", &["aris"]),
    ("SCOR", &["scorpio"]),
    ("ARK", &["arkansas"]),
    ("LBRA", &["libra"]),
    ("AQUA", &["aqua"]),
];

/// What Battle.net is started with to start the game: its launch code, or, for a game this list doesn't know yet,
/// Battle.net opened on the game's page, where the player presses Play.
fn launch_args(i: &Install) -> String {
    let known = |key: &str| LAUNCH_CODES.iter().find(|(_, keys)| keys.iter().any(|k| k.eq_ignore_ascii_case(key)));
    match known(&i.product).or_else(|| known(&i.uid)) {
        Some((code, _)) => format!("--exec=\"launch {code}\""),
        None => format!("--game={}", i.uid),
    }
}

pub fn games() -> Vec<Game> {
    let Some(app) = exe().filter(|e| e.is_file()) else { return Vec::new() };
    let Some(program_data) = std::env::var_os("ProgramData") else { return Vec::new() };
    let Ok(db) = std::fs::read(Path::new(&program_data).join(r"Battle.net\Agent\product.db")) else {
        return Vec::new();
    };
    let names = names();
    // An id that isn't a plain word never reaches Battle.net's command line.
    let plain = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_-.".contains(c));
    let mut out = Vec::new();
    for i in installs(&db) {
        // The agent and the Battle.net app list themselves too.
        if ["agent", "bna"].contains(&i.product.as_str()) || !i.installed || !plain(&i.uid) || !plain(&i.product) {
            continue;
        }
        if !on_a_drive(&i.dir) || !i.dir.is_dir() {
            log::info!("discovery battlenet: {} skipped, {} is missing", i.uid, i.dir.display());
            continue;
        }
        let name = names.get(&i.uid.to_lowercase()).map_or_else(|| prettify(&file_name(&i.dir)), |n| clean_name(n));
        let args = launch_args(&i);
        if args.starts_with("--game=") {
            log::info!("discovery battlenet: {name} has no launch code Lamplit knows; Battle.net opens on its page");
        }
        out.push(Game::new(
            format!("battlenet:{}", i.uid),
            name,
            Some(Store::Battlenet),
            i.dir,
            Launch::ExeArgs(app.clone(), args),
        ));
    }
    out
}

/// Each game's name by uid, from the installed-programs entry Battle.net writes for it, whose uninstall command ends
/// in `--uid=<uid>`.
fn names() -> HashMap<String, String> {
    let Ok(root) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(UNINSTALL) else { return HashMap::new() };
    root.enum_keys()
        .flatten()
        .filter_map(|k| root.open_subkey(k).ok())
        .filter_map(|k| {
            let command: String = k.get_value("UninstallString").ok()?;
            let name: String = k.get_value("DisplayName").ok()?;
            Some((uid_in(&command)?.to_lowercase(), name))
        })
        .collect()
}

/// `"…\Blizzard Uninstaller.exe" --lang=enUS --uid=prometheus --displayname="Overwatch"` gives "prometheus".
fn uid_in(command: &str) -> Option<&str> {
    command.split_whitespace().find_map(|w| w.strip_prefix("--uid=")).filter(|u| !u.is_empty())
}

/// Lines of Battle.net's log that settle whether a session is signed in. A session that fails on an old token and
/// then signs in with a password logs both, in that order, so the last one counts. The markers are the ones
/// unifideck's Battle.net support reads (battlenet_login_state.py); the signed-out ones also appear in a real log.
const SIGNED_IN: &str = "Logged into Battle.net successfully";
const SIGNED_OUT: [&str; 2] = ["Login failed. error=", "browser state changed: Login"];
/// A second Battle.net.exe, such as the one that hands a launch to the running app, writes a log of its own with this
/// line, which says nothing about the session.
const HANDOFF: &str = "Leaving because another instance of battle.net is running";

/// Whether Battle.net is signed in, from its own logs. `running_since`: when the running app started (seconds since
/// 1970), None when it isn't running.
pub fn account(running_since: Option<u64>) -> Account {
    account_in(&local_app_data().join(r"Battle.net\Logs"), running_since)
}

fn account_in(dir: &Path, running_since: Option<u64>) -> Account {
    let mut logs: Vec<(u64, PathBuf)> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            name.starts_with("battle.net-") && name.ends_with(".log")
        })
        .filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
            Some((modified.as_secs(), e.path()))
        })
        .collect();
    // Newest first: the name holds the time the session started.
    logs.sort_by(|a, b| b.1.cmp(&a.1));
    let state = |path: &PathBuf| read_text(path).and_then(|text| signed_in(&text));
    match running_since {
        // Only this run's logs count. Until they say so, it isn't signed in (yet).
        Some(since) => match logs.iter().filter(|(modified, _)| *modified >= since).find_map(|(_, p)| state(p)) {
            Some(true) => Account::SignedIn,
            _ => Account::SignedOut,
        },
        // A session that ended signed in signs in by itself at the next start.
        None => match logs.iter().find_map(|(_, p)| state(p)) {
            Some(true) => Account::Remembered,
            _ => Account::SignedOut,
        },
    }
}

/// What one log says: Some(true) signed in, Some(false) signed out, None nothing either way.
fn signed_in(log: &str) -> Option<bool> {
    if log.contains(HANDOFF) {
        return None;
    }
    log.lines().rev().find_map(|l| {
        if l.contains(SIGNED_IN) { Some(true) } else { SIGNED_OUT.iter().any(|m| l.contains(m)).then_some(false) }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::proto::build::{m, msg, s, v};
    use std::fs;

    /// A ProductInstall as product.db holds it, with the fields Lamplit doesn't read around the ones it does.
    fn product(uid: &str, code: &str, path: &str, installed: u64) -> Vec<u8> {
        let base = m(&[(1, v(installed)), (2, v(installed)), (7, s("1.0.0.12345"))]);
        msg(&[
            (1, s(uid)),
            (2, s(code)),
            (3, m(&[(1, s(path)), (2, s("eu")), (6, s("enUS"))])),
            (4, m(&[(1, base), (4, m(&[(4, v(1000))]))])),
            (7, v(0)),
        ])
    }

    fn product_db(products: &[Vec<u8>]) -> Vec<u8> {
        let mut parts: Vec<(u64, crate::stores::proto::build::Part)> =
            products.iter().map(|p| (1, crate::stores::proto::build::Part::Bytes(p.clone()))).collect();
        // The download settings and a counter after the products, as in a real product.db.
        parts.push((5, m(&[(2, v(1_000_000))])));
        parts.push((6, v(4_089_804)));
        msg(&parts)
    }

    #[test]
    fn reads_the_products() {
        let db = product_db(&[
            product("agent", "agent", "C:/ProgramData/Battle.net/Agent", 1),
            product("battle.net", "bna", "C:/Program Files (x86)/Battle.net", 1),
            product("prometheus", "pro", "D:/Games/Overwatch", 1),
            product("fenris", "fenris", "C:/Program Files (x86)/Diablo IV", 0),
        ]);
        let list = installs(&db);
        assert_eq!(list.len(), 4);
        assert_eq!(
            list[2],
            Install {
                uid: "prometheus".into(),
                product: "pro".into(),
                dir: PathBuf::from(r"D:\Games\Overwatch"),
                installed: true
            }
        );
        assert!(!list[3].installed);
        assert!(installs(b"").is_empty());
    }

    #[test]
    fn launch_codes() {
        let install = |uid: &str, product: &str| Install {
            uid: uid.into(),
            product: product.into(),
            dir: PathBuf::new(),
            installed: true,
        };
        assert_eq!(launch_args(&install("prometheus", "pro")), r#"--exec="launch Pro""#);
        assert_eq!(launch_args(&install("hs_beta", "hsb")), r#"--exec="launch WTCG""#);
        assert_eq!(launch_args(&install("fenris", "Fenris")), r#"--exec="launch Fen""#);
        // Known by its uid only.
        assert_eq!(launch_args(&install("diablo3", "d3_new")), r#"--exec="launch D3""#);
        assert_eq!(launch_args(&install("newgame", "ngame")), "--game=newgame");
    }

    #[test]
    fn uid_from_the_uninstall_command() {
        let command = r#""C:\ProgramData\Battle.net\Agent\Blizzard Uninstaller.exe" --lang=enUS --uid=battle.net --displayname="Battle.net""#;
        assert_eq!(uid_in(command), Some("battle.net"));
        assert_eq!(uid_in(r#""C:\Games\Other\unins000.exe" /SILENT"#), None);
        assert_eq!(uid_in("x.exe --uid="), None);
    }

    #[test]
    fn sign_in_from_the_log() {
        // A session whose saved sign-in had gone (lines from a real log), and the login page it then showed.
        let failed = "I 2026-10-21 12:55:06.482223 [BNLogin] {Main} BattleNetLogin::DeleteToken(): Deleting registry token because !m_lastEmailUsed.empty()\n\
            E 2026-10-21 12:55:06.578835 [BNLogin] {Main} Login failed. error=ERROR_TOKEN_NOT_FOUND (49)\n\
            D 2026-10-21 12:55:08.273926 [UnifiedAuth] {} UAuth: browser state changed: Login\n";
        assert_eq!(signed_in(failed), Some(false));
        // Then the player signs in with a password.
        let then_in =
            format!("{failed}I 2026-10-21 12:56:40.100000 [BNLogin] {{Main}} Logged into Battle.net successfully.\n");
        assert_eq!(signed_in(&then_in), Some(true));
        assert_eq!(signed_in("I [Main] {Main} Execution environment changed. environment=EE_STANDARD\n"), None);
        let handoff = "I [Main] {Main} Leaving because another instance of battle.net is running\n";
        assert_eq!(signed_in(handoff), None);
    }

    #[test]
    fn sign_in_from_the_newest_session() {
        let dir = std::env::temp_dir().join(format!("lamplit-test-battlenet-logs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let log = |name: &str, text: &str, modified: u64| {
            let path = dir.join(format!("battle.net-{name}.log"));
            fs::write(&path, text).unwrap();
            let file = fs::File::options().write(true).open(&path).unwrap();
            file.set_modified(UNIX_EPOCH + std::time::Duration::from_secs(modified)).unwrap();
        };
        log("20261020T100000.000000", "I [BNLogin] {Main} Logged into Battle.net successfully.\n", 1000);
        // A launch handed to the running app, which says nothing about the session.
        log("20261020T110000.000000", &format!("I [Main] {{Main}} {HANDOFF}\n"), 1100);
        assert_eq!(account_in(&dir, None), Account::Remembered);
        // Running since 2000: the session before doesn't count, and this one hasn't signed in yet.
        log("20261021T100000.000000", "I [Main] {Main} Execution environment changed.\n", 2001);
        assert_eq!(account_in(&dir, Some(2000)), Account::SignedOut);
        log("20261021T100000.000000", "I [BNLogin] {Main} Logged into Battle.net successfully.\n", 2005);
        assert_eq!(account_in(&dir, Some(2000)), Account::SignedIn);
        // That session then ended on the login page.
        log("20261021T100000.000000", "E [BNLogin] {Main} Login failed. error=ERROR_TOKEN_NOT_FOUND (49)\n", 2010);
        assert_eq!(account_in(&dir, None), Account::SignedOut);
        assert_eq!(account_in(&dir.join("missing"), None), Account::SignedOut);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_claimed_battlenet_folder_is_no_game_outside_a_store() {
        // Before Lamplit read Battle.net, its games turned up outside any store: by the installed-programs entry
        // Battle.net writes, and by the exe Windows saw run (World of Warcraft runs from _retail_).
        use crate::stores::installed::Program;
        use crate::stores::loose;
        let root = std::env::temp_dir().join(format!("lamplit-test-battlenet-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let wow = root.join("World of Warcraft");
        let wow_exe = wow.join(r"_retail_\Wow.exe");
        fs::create_dir_all(wow_exe.parent().unwrap()).unwrap();
        fs::write(&wow_exe, [0u8; 100]).unwrap();
        fs::write(wow.join(r"_retail_\bink2w64.dll"), [0u8; 10]).unwrap();
        let claimed = [Game::new(
            "battlenet:wow".into(),
            "World of Warcraft".into(),
            Some(Store::Battlenet),
            wow.clone(),
            Launch::ExeArgs(PathBuf::from("Battle.net.exe"), r#"--exec="launch WoW""#.into()),
        )];
        let programs =
            [Program { name: "World of Warcraft".into(), folder: Some(wow.clone()), exe: Some(wow_exe.clone()) }];
        let roots = std::slice::from_ref(&root);
        assert!(loose::games(&claimed, std::slice::from_ref(&wow_exe), roots, &programs).is_empty());
        // Without the store's entry, the same folder was a game outside any store.
        assert_eq!(loose::games(&[], &[wow_exe], roots, &programs).len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
