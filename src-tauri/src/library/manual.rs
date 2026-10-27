// Games the player adds by hand (Settings > Add a game): picked from the installed programs discovery passed over, or
// found by browsing the PC's drives for an exe. They are kept in games.json, and launched by their exe like games
// outside any store.

use super::{Game, Launch};
use crate::error::{Error, Result};
use crate::files::{file_name, folder_key, on_a_drive};
use crate::stores::Installed;
use crate::stores::loose::{game_folder, is_container, name_for, passed_over};
use crate::win;
use serde::{Deserialize, Serialize};
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// A game added by hand, as games.json keeps it.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Manual {
    pub name: String,
    pub exe: PathBuf,
}

/// The id of the game `exe` starts.
pub fn id(exe: &Path) -> String {
    format!("manual:{}", folder_key(exe))
}

/// The exe of the game added by hand as `id`, in lower case.
pub fn exe_of(id: &str) -> Option<PathBuf> {
    id.strip_prefix("manual:").map(PathBuf::from)
}

/// The game a games.json entry adds. Its folder is the exe's game folder, so the watch after a launch counts every
/// process from there as the game, as it does for games outside any store.
pub fn game(id: &str, m: &Manual) -> Game {
    let mut g = Game::new(id.into(), m.name.clone(), None, game_folder(&m.exe), Launch::Exe(m.exe.clone()));
    g.manual = true;
    g
}

/// Whether `exe` can be added as a game next to `games`, or what the player reads when it can't.
pub fn check(exe: &Path, games: &[Game]) -> Result<()> {
    let is_exe = exe.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe"));
    if !on_a_drive(exe) || !is_exe || !exe.is_file() {
        return Err(Error::Player(format!("{} isn't an exe on this PC's drives.", exe.display())));
    }
    let dir = game_folder(exe);
    // Taken for the game's folder, every program in it would count as the game while it runs.
    if is_container(&dir) {
        return Err(Error::Player(format!(
            "{} holds other programs too. Pick an exe in the game's own folder.",
            dir.display()
        )));
    }
    let key = folder_key(&dir);
    let overlaps = |d: &PathBuf| {
        let other = folder_key(d);
        key == other || key.starts_with(&format!("{other}\\")) || other.starts_with(&format!("{key}\\"))
    };
    if let Some(g) = games.iter().find(|g| std::iter::once(&g.dir).chain(&g.extra_dirs).any(overlaps)) {
        let hidden = if g.hidden { " It is hidden: Settings > Hidden games shows it again." } else { "" };
        return Err(Error::Player(format!("That folder belongs to {}, which Lamplit already has.{hidden}", g.name)));
    }
    Ok(())
}

/// An installed program that isn't in the library.
#[derive(Serialize)]
pub struct Program {
    pub name: String,
    pub exe: String,
    /// Where it is installed.
    pub folder: String,
}

/// The installed programs that aren't among `games`, A to Z.
pub fn programs(games: &[Game]) -> Vec<Program> {
    passed_over(games, &Installed::read())
        .into_iter()
        .map(|(name, exe)| Program { name, folder: path_string(&game_folder(&exe)), exe: path_string(&exe) })
        .collect()
}

/// One folder of the PC, as the player browses for a game's exe.
#[derive(Serialize)]
pub struct Folder {
    /// None for the list of drives.
    pub path: Option<String>,
    /// The folder above; None at a drive's root, where Back goes to the drives.
    pub parent: Option<String>,
    pub entries: Vec<FolderEntry>,
}

#[derive(Serialize)]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    /// For an exe: the name the game would get, as discovery names a game outside any store.
    pub title: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Debug, Serialize)]
#[cfg_attr(test, derive(strum::VariantArray))]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Drive,
    Folder,
    Exe,
}

/// The folders and exes in `path`, folders first, each A to Z; with no path, the PC's fixed drives. Hidden and
/// system files and folders are left out, as Explorer does.
pub fn browse(path: Option<&str>) -> Result<Folder> {
    let Some(path) = path else {
        let entries = win::drives::fixed()
            .into_iter()
            .map(|d| {
                let root = path_string(&d);
                FolderEntry {
                    name: root.trim_end_matches('\\').into(),
                    path: root,
                    kind: EntryKind::Drive,
                    title: None,
                }
            })
            .collect();
        return Ok(Folder { path: None, parent: None, entries });
    };
    let dir = PathBuf::from(path);
    // A path that isn't on a drive letter could reach another computer, which Windows would sign in to.
    if !on_a_drive(&dir) {
        return Err(Error::Player(format!("{path} isn't on this PC's drives.")));
    }
    let listing = std::fs::read_dir(&dir).map_err(|e| Error::Player(format!("Can't open {path}: {e}")))?;
    let mut entries: Vec<FolderEntry> =
        listing.flatten().filter_map(|e| entry(&e.path(), &e.metadata().ok()?)).collect();
    entries.sort_by_cached_key(|e| (e.kind != EntryKind::Folder, e.name.to_lowercase()));
    Ok(Folder { path: Some(path.into()), parent: dir.parent().map(path_string), entries })
}

fn entry(path: &Path, meta: &std::fs::Metadata) -> Option<FolderEntry> {
    const HIDDEN: u32 = 0x2;
    const SYSTEM: u32 = 0x4;
    if meta.file_attributes() & (HIDDEN | SYSTEM) != 0 {
        return None;
    }
    let exe = path.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe"));
    let kind = if meta.is_dir() {
        EntryKind::Folder
    } else if exe {
        EntryKind::Exe
    } else {
        return None;
    };
    let title = (kind == EntryKind::Exe).then(|| name_for(path));
    Some(FolderEntry { name: file_name(path), path: path_string(path), kind, title })
}

fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::Store;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lamplit-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn file(p: PathBuf) -> PathBuf {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(&p, b"MZ").unwrap();
        p
    }

    fn message(r: Result<()>) -> String {
        match r {
            Err(Error::Player(m)) => m,
            other => panic!("expected a message for the player, got {other:?}"),
        }
    }

    #[test]
    fn adds_an_exe_in_a_folder_of_its_own() {
        let root = scratch("manual-check");
        let exe = file(root.join(r"Old Games\Racer\bin\racer.exe"));
        let store_dir = root.join(r"Old Games\Store Game");
        let other = file(store_dir.join(r"tools\tool.exe"));
        let mut store_game =
            Game::new("epic:s".into(), "Store Game".into(), Some(Store::Epic), store_dir, Launch::Uri("x".into()));
        assert!(check(&exe, &[store_game.clone()]).is_ok());
        // Its game is Racer, above bin.
        assert_eq!(game("id", &Manual { name: "Racer".into(), exe: exe.clone() }).dir, root.join(r"Old Games\Racer"));

        store_game.hidden = true;
        let inside = message(check(&other, &[store_game.clone()]));
        assert!(inside.starts_with("That folder belongs to Store Game") && inside.contains("Hidden games"), "{inside}");
        // A folder that holds a game's folder would count the game's processes as its own.
        let holder = file(root.join(r"Old Games\launcher.exe"));
        store_game.dir = root.join(r"Old Games\launcher\Store Game");
        let above = root.join(r"Old Games\launcher");
        let holder_in_own = file(above.join("launcher.exe"));
        assert!(message(check(&holder_in_own, &[store_game])).starts_with("That folder belongs to Store Game"));
        // Right in a folder named Games: no folder of its own.
        let loose = file(root.join(r"Games\tetris.exe"));
        assert!(message(check(&loose, &[])).contains("holds other programs too"));
        assert!(check(&holder, &[]).is_ok());
        assert!(message(check(&root.join(r"Old Games\Racer\readme.txt"), &[])).contains("isn't an exe"));
        assert!(message(check(Path::new(r"\\nas\games\x.exe"), &[])).contains("isn't an exe on this PC's drives"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn browses_folders_and_exes() {
        let root = scratch("manual-browse");
        file(root.join(r"Zed\z.exe"));
        file(root.join(r"alpha\a.txt"));
        file(root.join("Game.EXE"));
        file(root.join("notes.txt"));
        file(root.join("b.exe"));
        fs::create_dir_all(root.join("Secret")).unwrap();
        let secret = std::process::Command::new("attrib").arg("+h").arg(root.join("Secret")).status().unwrap();
        assert!(secret.success());
        let folder = browse(Some(&path_string(&root))).unwrap();
        let listed: Vec<(&str, EntryKind)> = folder.entries.iter().map(|e| (e.name.as_str(), e.kind)).collect();
        assert_eq!(
            listed,
            [
                ("alpha", EntryKind::Folder),
                ("Zed", EntryKind::Folder),
                ("b.exe", EntryKind::Exe),
                ("Game.EXE", EntryKind::Exe)
            ]
        );
        assert_eq!(folder.parent, root.parent().map(path_string));
        // The title an exe in its own folder gets is the folder's.
        let zed = browse(Some(&path_string(&root.join("Zed")))).unwrap();
        assert_eq!(zed.entries[0].title.as_deref(), Some("Zed"));
        assert!(browse(Some(r"\\nas\games")).is_err());
        let drives = browse(None).unwrap();
        assert!(drives.path.is_none() && drives.entries.iter().any(|d| d.name == "C:" && d.kind == EntryKind::Drive));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn payloads_reach_the_page_as_in_their_fixtures() {
        let folder = Folder {
            path: Some(r"D:\Games".into()),
            parent: Some(r"D:\".into()),
            entries: vec![
                FolderEntry {
                    name: "Racer".into(),
                    path: r"D:\Games\Racer".into(),
                    kind: EntryKind::Folder,
                    title: None,
                },
                FolderEntry {
                    name: "tetris.exe".into(),
                    path: r"D:\Games\tetris.exe".into(),
                    kind: EntryKind::Exe,
                    title: Some("Tetris".into()),
                },
            ],
        };
        assert_eq!(serde_json::to_value(folder).unwrap(), ipc_fixture!("folder"));
        let kinds = <EntryKind as strum::VariantArray>::VARIANTS;
        assert_eq!(serde_json::to_value(kinds).unwrap(), ipc_fixture!("values")["entry_kind"]);
        let program = Program {
            name: "Old Racer".into(),
            exe: r"C:\Program Files\Old Racer\racer.exe".into(),
            folder: r"C:\Program Files\Old Racer".into(),
        };
        assert_eq!(serde_json::to_value([program]).unwrap(), ipc_fixture!("programs"));
    }
}
