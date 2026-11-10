// Screenshots already on the PC. Only a game's own Steam id is used, never its chosen or matched store art.

use super::{Game, Library, name_match};
use crate::error::{Error, Result};
use crate::files::{folder_key, local_app_data, on_a_drive};
use crate::stores::{names::clean_name, read, steam};
use crate::win;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::{AppHandle, Manager};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use winreg::{
    RegKey,
    enums::{HKEY_CURRENT_USER, REG_BINARY, REG_EXPAND_SZ, REG_SZ},
};

const LIMIT: usize = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Steam,
    Gamebar,
    Nvidia,
}

#[derive(Serialize)]
pub struct Capture {
    pub path: String,
    pub taken: String,
    pub source: Source,
}

struct Found {
    path: PathBuf,
    taken: SystemTime,
    source: Source,
}

pub fn for_game(app: &AppHandle, id: &str) -> Result<Vec<Capture>> {
    let game =
        app.state::<Library>().game(id).ok_or_else(|| Error::Player("That game isn't installed any more.".into()))?;
    let videos = win::captures::videos()?;
    let gamebar = registry_path(r"Software\Microsoft\Windows\CurrentVersion\GameDVR", "AppCaptureFolder")?
        .unwrap_or_else(|| {
            win::captures::gamebar().unwrap_or_else(|e| {
                log::warn!("captures: Windows couldn't locate Captures: {e}; using Videos\\Captures");
                videos.join("Captures")
            })
        });
    let nvidia = nvidia_roots(&videos)?;
    let found = collect(&game, steam::path().as_deref(), &gamebar, &nvidia)?;
    let scope = app.asset_protocol_scope();
    let mut allowed = HashSet::new();
    found
        .into_iter()
        .map(|capture| {
            let folder = capture.path.parent().expect("a capture has a containing folder");
            if allowed.insert(folder_key(folder)) {
                scope.allow_directory(folder, false)?;
            }
            payload(capture)
        })
        .collect()
}

fn payload(capture: Found) -> Result<Capture> {
    // One encoded path segment, as convertFileSrc uses for Windows' http asset protocol.
    let mut url = tauri::Url::parse("http://asset.localhost/").expect("the asset origin is a URL");
    url.path_segments_mut().expect("the asset URL has a path").push(&capture.path.to_string_lossy());
    let taken = OffsetDateTime::from(capture.taken)
        .format(&Rfc3339)
        .map_err(|e| Error::Internal(format!("captures: invalid file time: {e}")))?;
    Ok(Capture { path: url.into(), taken, source: capture.source })
}

fn registry_path(key: &str, name: &str) -> Result<Option<PathBuf>> {
    let Some(key) = read::optional(RegKey::predef(HKEY_CURRENT_USER).open_subkey(key))? else { return Ok(None) };
    let Some(value) = read::optional(key.get_raw_value(name))? else { return Ok(None) };
    // GeForce Experience stores DefaultPathW as UTF-16 REG_BINARY; Game Bar uses a registry string.
    if !matches!(value.vtype, REG_BINARY | REG_SZ | REG_EXPAND_SZ) {
        return Err(Error::Internal(format!("captures: {name} has an unsupported registry type")));
    }
    let text = wide_path(&value.bytes)?;
    if text.is_empty() {
        return Ok(None);
    }
    Ok(Some(win::captures::expand(&text)?))
}

fn wide_path(bytes: &[u8]) -> Result<String> {
    if !bytes.len().is_multiple_of(2) {
        return Err(Error::Internal("captures: an incomplete UTF-16 folder setting".into()));
    }
    let units: Vec<u16> =
        bytes.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).take_while(|&unit| unit != 0).collect();
    String::from_utf16(&units).map_err(|e| Error::Internal(format!("captures: invalid folder setting: {e}")))
}

#[derive(Deserialize)]
struct GallerySettings {
    #[serde(rename = "currentDirectoryV2")]
    directory: Option<PathBuf>,
}

fn nvidia_roots(videos: &Path) -> Result<Vec<PathBuf>> {
    // Defaults from both overlay generations also keep older captures visible after the gallery is moved.
    let mut roots = vec![videos.to_path_buf(), videos.join("NVIDIA")];
    if let Some(text) = read::text(&local_app_data().join(r"NVIDIA Corporation\NVIDIA Overlay\GallerySettings.json"))? {
        let settings: GallerySettings = serde_json::from_str(&text)?;
        roots.extend(settings.directory);
    }
    roots.extend(registry_path(r"Software\NVIDIA Corporation\Global\ShadowPlay\NVSPCAPS", "DefaultPathW")?);
    Ok(roots)
}

fn collect(game: &Game, steam: Option<&Path>, gamebar: &Path, nvidia: &[PathBuf]) -> Result<Vec<Found>> {
    let mut found = Vec::new();
    if let (Some(root), Some(appid)) = (steam.filter(|p| on_a_drive(p)), game.steam_appid)
        && let Some(folder) = steam_folder(root, appid)?
    {
        images(&folder, Source::Steam, None, &mut found)?;
    }
    let name = name_key(&game.name);
    if !name.is_empty() {
        if on_a_drive(gamebar) {
            images(gamebar, Source::Gamebar, Some(&name), &mut found)?;
        }
        let mut scanned = HashSet::new();
        for root in nvidia.iter().filter(|p| on_a_drive(p)) {
            if !scanned.insert(folder_key(root)) {
                continue;
            }
            for folder in read::subdirs(root)? {
                if name_key(&crate::files::file_name(&folder)) == name {
                    images(&folder, Source::Nvidia, None, &mut found)?;
                }
            }
        }
    }
    found.sort_by(|a, b| b.taken.cmp(&a.taken).then_with(|| a.path.cmp(&b.path)));
    let mut seen = HashSet::new();
    found.retain(|f| seen.insert(folder_key(&f.path)));
    found.truncate(LIMIT);
    Ok(found)
}

fn steam_folder(root: &Path, appid: u32) -> Result<Option<PathBuf>> {
    let Some(text) = read::text(&root.join(r"config\loginusers.vdf"))? else { return Ok(None) };
    Ok(steam::last_account(&text)
        .map(|account| root.join(format!(r"userdata\{account}\760\remote\{appid}\screenshots"))))
}

fn name_key(name: &str) -> String {
    name_match::norm(&clean_name(name).to_lowercase())
}

/// Game Bar names a capture after the game, then the date and time ("Portal 2 2026-11-10 12-30-00", or
/// "Portal 2 11_10_2026 12_30_00 PM" on older Windows). The whole title has to be the game's, so Portal's captures
/// leave out Portal 2's.
fn titled(stem: &str, name: &str) -> bool {
    let mut title = stem.trim_end();
    while let Some((rest, last)) = title.rsplit_once(' ') {
        let stamp = last.contains(['-', '_']) && last.chars().all(|c| c.is_ascii_digit() || c == '-' || c == '_');
        if !stamp && !last.eq_ignore_ascii_case("am") && !last.eq_ignore_ascii_case("pm") {
            break;
        }
        title = rest.trim_end();
    }
    name_key(title) == name
}

fn images(folder: &Path, source: Source, name: Option<&str>, found: &mut Vec<Found>) -> Result<()> {
    for entry in read::entries(folder)? {
        let path = entry.path();
        let extension = path.extension().unwrap_or_default().to_string_lossy().to_ascii_lowercase();
        if !matches!(extension.as_str(), "png" | "jpg" | "jpeg")
            || name.is_some_and(|n| !titled(&path.file_stem().unwrap_or_default().to_string_lossy(), n))
        {
            continue;
        }
        // Do not follow a link that makes a capture folder expose files elsewhere.
        if !read::optional(entry.file_type())?.is_some_and(|t| t.is_file()) {
            continue;
        }
        let Some(meta) = read::optional(entry.metadata())? else { continue };
        found.push(Found { path, taken: meta.modified()?, source });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{ArtChoice, Launch};
    use std::fs::{self, File, FileTimes};
    use std::time::{Duration, UNIX_EPOCH};

    fn game() -> Game {
        Game::new("steam:70".into(), "Game™: Name".into(), None, PathBuf::new(), Launch::Uri(String::new()))
    }

    fn image(path: &Path, seconds: u64) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"image fixture").unwrap();
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(seconds)))
            .unwrap();
    }

    #[test]
    fn finds_only_the_games_images_and_last_steam_account() {
        let root = std::env::temp_dir().join(format!("lamplit-captures-layout-{}", std::process::id()));
        let steam = root.join("Steam");
        fs::create_dir_all(steam.join("config")).unwrap();
        fs::write(
            steam.join(r"config\loginusers.vdf"),
            r#""users" { "76561197960265729" { "Timestamp" "1" } "76561197960265730" { "Timestamp" "2" } }"#,
        )
        .unwrap();
        let selected = steam.join(r"userdata\2\760\remote\70\screenshots");
        image(&selected.join("shot.jpg"), 30);
        fs::create_dir(selected.join("not-an-image.png")).unwrap();
        image(&selected.join(r"thumbnails\shot.jpg"), 100);
        image(&steam.join(r"userdata\1\760\remote\70\screenshots\old-account.jpg"), 100);
        image(&steam.join(r"userdata\2\760\remote\71\screenshots\other-game.jpg"), 100);
        let bar = root.join("Captures");
        image(&bar.join("GAME NAME 2026-11-10 12-30-00.PNG"), 20);
        image(&bar.join("Game Names 2026-11-10 12-30-00.png"), 100);
        image(&bar.join("Other Game Name.png"), 100);
        image(&bar.join("Game Name clip.mp4"), 100);
        let videos = root.join("Videos");
        image(&videos.join(r"game name\shot.JPEG"), 10);
        image(&videos.join(r"game names\other.png"), 100);
        let mut game = game();
        game.steam_appid = Some(70);
        let shots = collect(&game, Some(&steam), &bar, &[videos.clone(), videos.clone()]).unwrap();
        assert_eq!(shots.len(), 3);
        assert_eq!(
            shots.iter().map(|f| f.source).collect::<Vec<_>>(),
            vec![Source::Steam, Source::Gamebar, Source::Nvidia]
        );
        game.steam_appid = None;
        game.art_choice = Some(ArtChoice::Steam(70));
        assert_eq!(collect(&game, Some(&steam), &bar, &[videos]).unwrap().len(), 2);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sorts_and_limits_all_sources_together() {
        let root = std::env::temp_dir().join(format!("lamplit-captures-limit-{}", std::process::id()));
        let bar = root.join("Captures");
        for i in 0..65 {
            image(&bar.join(format!("Game Name 2026-11-10 12-30-{i:02}.jpg")), i + 1);
        }
        let gallery = root.join("Custom gallery");
        image(&gallery.join(r"Game Name\nvidia.png"), 70);
        let shots = collect(&game(), None, &bar, &[gallery]).unwrap();
        assert_eq!(shots.len(), LIMIT);
        assert_eq!(shots.first().unwrap().source, Source::Nvidia);
        assert_eq!(shots.first().unwrap().taken, UNIX_EPOCH + Duration::from_secs(70));
        assert_eq!(shots.last().unwrap().taken, UNIX_EPOCH + Duration::from_secs(7));
        assert!(shots.windows(2).all(|w| w[0].taken > w[1].taken));
        assert!(collect(&game(), None, &root.join("missing"), &[]).unwrap().is_empty());
        assert!(collect(&game(), None, &bar.join("Game Name 2026-11-10 12-30-00.jpg"), &[]).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn matches_case_trademarks_and_punctuation_but_not_other_names() {
        assert!(titled("Game®: Name 2026-11-10 12-30-00", "game name"));
        assert!(titled("Tom Clancy's Game 11_10_2026 12_30_00 PM", "tom clancy s game"));
        assert!(titled("POKÉMON™ 2026-11-10 12-30-00", &name_key("Pokémon")));
        assert!(titled("Portal 2 2026-11-10 12-30-00", &name_key("Portal 2")));
        assert!(!titled("Portal 2 2026-11-10 12-30-00", &name_key("Portal")));
        assert!(!titled("Portal 2 11_10_2026 12_30_00 PM", &name_key("Portal")));
        assert!(!titled("Game Names 2026-11-10 12-30-00", "game name"));
        assert!(!titled("Another Game Name", "game name"));
    }

    #[test]
    fn never_reads_network_capture_folders() {
        let network = Path::new(r"\\server\captures");
        let mut game = game();
        game.steam_appid = Some(70);
        assert!(collect(&game, Some(network), network, &[network.to_path_buf()]).unwrap().is_empty());
    }

    #[test]
    fn decodes_custom_nvidia_locations() {
        let settings: GallerySettings = serde_json::from_str(r#"{"currentDirectoryV2":"D:\\Captures"}"#).unwrap();
        assert_eq!(settings.directory, Some(PathBuf::from(r"D:\Captures")));
        let bytes: Vec<u8> = r"D:\Captures".encode_utf16().chain(Some(0)).flat_map(u16::to_le_bytes).collect();
        assert_eq!(wide_path(&bytes).unwrap(), r"D:\Captures");
        assert!(wide_path(&[1]).is_err());
    }

    #[test]
    fn reaches_the_page_as_in_its_fixture() {
        let sources = [Source::Steam, Source::Gamebar, Source::Nvidia];
        let captures: Vec<Capture> = sources
            .into_iter()
            .map(|source| {
                payload(Found {
                    path: PathBuf::from(r"C:\Captures\Game #1.png"),
                    taken: UNIX_EPOCH + Duration::from_hours(497_976),
                    source,
                })
                .unwrap()
            })
            .collect();
        assert_eq!(serde_json::to_value(captures).unwrap(), ipc_fixture!("captures"));
    }
}
