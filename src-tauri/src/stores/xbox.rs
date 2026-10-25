// The Xbox app: games are the packages installed for this user that carry a MicrosoftGame.config. They start without
// a launcher window and use the Windows account, so there is no store app to start or sign in.

use super::names::{clean_name, prettify};
use super::{Store, xml};
use crate::files::{file_name, read_text, subdirs};
use crate::library::{Game, Launch};
use std::path::{Path, PathBuf};
use winreg::RegKey;
use winreg::enums::HKEY_CURRENT_USER;

/// Licence and update trouble with Xbox games is sorted out in the Microsoft Store.
pub const WINDOW: &str = "ms-windows-store://downloadsandupdates";

/// Packages installed for this user, from the registry behind Get-AppxPackage (PowerShell itself takes a second).
/// Full names look like `Name_Version_Arch_ResourceId_PublisherId`; the family name is `Name_PublisherId`.
struct Package {
    name: String,
    family: String,
    dir: PathBuf,
}

fn packages() -> Vec<Package> {
    const REPO: &str =
        r"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages";
    let Ok(root) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(REPO) else { return Vec::new() };
    root.enum_keys()
        .flatten()
        .filter_map(|full| {
            let dir: String = root.open_subkey(&full).ok()?.get_value("PackageRootFolder").ok()?;
            let parts: Vec<&str> = full.split('_').collect();
            let (name, publisher) = (parts.first()?, parts.last()?);
            (parts.len() == 5).then(|| Package {
                name: name.to_string(),
                family: format!("{name}_{publisher}"),
                dir: dir.into(),
            })
        })
        .collect()
}

pub fn games(drives: &[PathBuf]) -> Vec<Game> {
    // The games themselves live in <drive>:\XboxGames\<title>\Content, keyed by the package identity.
    let mut mirrors: Vec<(String, PathBuf)> = Vec::new();
    for dir in drives.iter().flat_map(|d| subdirs(&d.join("XboxGames"))) {
        if let Some(text) = read_text(&dir.join(r"Content\MicrosoftGame.config"))
            && let Some(id) = xml::tag_attrs(&xml::strip_comments(&text), "Identity", "Name").into_iter().next()
        {
            mirrors.push((id.to_lowercase(), dir));
        }
    }
    let mut out = Vec::new();
    for p in packages() {
        // Games are the packages with a MicrosoftGame.config; the app to start is in the package manifest.
        let Some(config) = read_text(&p.dir.join("MicrosoftGame.config")).map(|t| xml::strip_comments(&t)) else {
            continue;
        };
        let manifest = read_text(&p.dir.join("AppxManifest.xml")).map(|t| xml::strip_comments(&t)).unwrap_or_default();
        let Some(app) = xml::tag_attrs(&manifest, "Application", "Id").into_iter().next() else { continue };
        let dir = p.dir.clone();
        let name = xml::tag_attrs(&config, "ShellVisuals", "DefaultDisplayName")
            .into_iter()
            .find(|n| !n.starts_with("ms-resource:"))
            .map(|n| clean_name(&n))
            .unwrap_or_else(|| prettify(p.name.split_once('.').map_or(p.name.as_str(), |(_, n)| n)));
        let mut g = Game::new(
            format!("xbox:{}", p.family),
            name,
            Some(Store::Xbox),
            dir.clone(),
            Launch::Uri(format!("shell:AppsFolder\\{}!{app}", p.family)),
        );
        g.exe_names = xml::tag_attrs(&config, "Executable", "Name")
            .iter()
            .map(|n| file_name(Path::new(&n.replace('/', "\\"))).to_lowercase())
            .collect();
        g.extra_dirs = mirrors.iter().filter(|(id, _)| *id == p.name.to_lowercase()).map(|(_, d)| d.clone()).collect();
        if let Ok(target) = std::fs::read_link(&dir) {
            g.extra_dirs.push(target);
        }
        out.push(g);
    }
    out
}
