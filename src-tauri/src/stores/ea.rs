// The EA app: its games (each carries `__Installer\installerdata.xml`) and its remembered sign-in.

use super::installed::Program;
use super::names::{clean_name, prettify};
use super::{Store, machine_value, xml};
use crate::files::{file_name, folder_key, local_app_data, nonempty, read_text, subdirs};
use crate::library::{Game, Launch};
use std::path::PathBuf;

pub fn exe() -> Option<PathBuf> {
    machine_value(r"SOFTWARE\Electronic Arts\EA Desktop", "DesktopAppPath").map(PathBuf::from)
}

/// EA games sit in the usual EA folders, or wherever the installed-programs list says.
pub fn games(drives: &[PathBuf], programs: &[Program]) -> Vec<Game> {
    let mut roots: Vec<PathBuf> =
        std::env::var_os("ProgramFiles").map(|p| PathBuf::from(p).join("EA Games")).into_iter().collect();
    for d in drives {
        roots.push(d.join("Games"));
        roots.push(d.join("EA Games"));
    }
    let mut dirs: Vec<PathBuf> = roots.iter().flat_map(|r| subdirs(r)).collect();
    dirs.extend(programs.iter().filter_map(|p| p.folder.clone()));
    dirs.sort_by_key(|d| folder_key(d));
    dirs.dedup_by_key(|d| folder_key(d));

    let mut out = Vec::new();
    for dir in dirs {
        let Some(text) = read_text(&dir.join(r"__Installer\installerdata.xml")) else { continue };
        let Some(content_id) = xml::between(&text, "<contentID>", "</contentID>").map(str::trim) else { continue };
        let title = xml::between(&text, "<gameTitle locale=\"en_US\">", "</gameTitle>")
            .or_else(|| {
                xml::between(&text, "<gameTitle", "</gameTitle>").and_then(|t| t.split_once('>').map(|(_, n)| n))
            })
            .map(|t| clean_name(&xml::unescape(t)))
            .unwrap_or_else(|| prettify(&file_name(&dir)));
        out.push(Game::new(
            format!("ea:{content_id}"),
            title,
            Some(Store::Ea),
            dir.clone(),
            Launch::Uri(format!("origin2://game/launch?offerIds={content_id}")),
        ));
    }
    out
}

pub fn remembered() -> bool {
    nonempty(&local_app_data().join(r"Electronic Arts\EA Desktop\cookie.ini"))
}
