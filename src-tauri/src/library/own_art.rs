// The art the player gives a game from files on the PC, in Change art: a cover, a background, a logo and a trailer.
// Each file is copied into the data folder (art\own\, which the page may already read), so moving or deleting the
// original leaves the game as it was. games.json keeps the copies' names. Each one shows in place of the art of its
// kind from Steam, or of no art; a kind without a file keeps what it showed before.

use super::{Art, ArtKind, OwnArt};
use crate::data::data_dir;
use crate::error::{Error, Result};
use crate::files::{inside, on_a_drive};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// What WebView2 shows as a picture, and plays as a video.
const PICTURES: &[&str] = &["jpg", "jpeg", "png", "webp", "avif", "gif", "bmp"];
const VIDEOS: &[&str] = &["mp4", "webm", "m4v", "mov"];

fn dir() -> PathBuf {
    data_dir().join("art").join("own")
}

fn extensions(kind: ArtKind) -> &'static [&'static str] {
    if kind == ArtKind::Trailer { VIDEOS } else { PICTURES }
}

/// The extension of `file`, in lower case, when it is one `kind` takes.
fn extension(kind: ArtKind, file: &Path) -> Option<String> {
    let ext = file.extension()?.to_str()?.to_lowercase();
    extensions(kind).contains(&ext.as_str()).then_some(ext)
}

/// `file` can be a game's `kind` of art.
pub fn takes(kind: ArtKind, file: &Path) -> bool {
    extension(kind, file).is_some()
}

/// The copies games.json names, as full paths.
pub fn paths(names: &BTreeMap<ArtKind, String>) -> OwnArt {
    paths_in(&dir(), names)
}

/// A name that leads out of `dir` (a games.json edited by hand) counts as none.
fn paths_in(dir: &Path, names: &BTreeMap<ArtKind, String>) -> OwnArt {
    let path = |kind| Some(inside(dir, names.get(&kind)?)?.to_string_lossy().into_owned());
    OwnArt {
        portrait: path(ArtKind::Portrait),
        hero: path(ArtKind::Hero),
        logo: path(ArtKind::Logo),
        trailer: path(ArtKind::Trailer),
    }
}

/// `art` with the player's own files in place of their kinds.
pub fn over(art: Art, own: &OwnArt) -> Art {
    Art {
        portrait: own.portrait.clone().or(art.portrait),
        hero: own.hero.clone().or(art.hero),
        logo: own.logo.clone().or(art.logo),
    }
}

/// Copies `file` into the data folder as a `kind` of art, and returns the copy's name.
pub fn copy_in(kind: ArtKind, file: &Path) -> Result<String> {
    copy_into(&dir(), kind, file)
}

/// Each copy has a name of its own, so the page never shows the file it read before under the same address.
fn copy_into(dir: &Path, kind: ArtKind, file: &Path) -> Result<String> {
    // A path that isn't on a drive letter could reach another computer, which Windows would sign in to.
    let ext = extension(kind, file).filter(|_| on_a_drive(file) && file.is_file()).ok_or_else(|| {
        let what = if kind == ArtKind::Trailer { "a video Lamplit can play" } else { "a picture Lamplit can show" };
        Error::Player(format!("{} isn't {what} on this PC's drives.", file.display()))
    })?;
    let millis = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis());
    let name = format!("{}-{millis}.{ext}", format!("{kind:?}").to_lowercase());
    std::fs::create_dir_all(dir)?;
    let copy = dir.join(&name);
    if let Err(e) = std::fs::copy(file, &copy) {
        let _ = std::fs::remove_file(&copy);
        return Err(Error::Player(format!("Can't copy {}: {e}", file.display())));
    }
    Ok(name)
}

/// Deletes a copy the player no longer uses.
pub fn remove(name: &str) {
    remove_from(&dir(), name);
}

fn remove_from(dir: &Path, name: &str) {
    let Some(copy) = inside(dir, name) else { return };
    if let Err(e) = std::fs::remove_file(&copy) {
        log::warn!("art: can't delete {}: {e}", copy.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_pictures_and_videos_webview2_shows() {
        for file in ["cover.JPG", "a.jpeg", "b.png", "c.webp", "d.avif", "e.gif", "f.bmp"] {
            assert!(takes(ArtKind::Portrait, Path::new(file)) && takes(ArtKind::Logo, Path::new(file)), "{file}");
            assert!(!takes(ArtKind::Trailer, Path::new(file)), "{file}");
        }
        for file in ["trailer.mp4", "t.WEBM", "t.m4v", "t.mov"] {
            assert!(takes(ArtKind::Trailer, Path::new(file)) && !takes(ArtKind::Hero, Path::new(file)), "{file}");
        }
        for file in ["cover.tiff", "trailer.mkv", "notes.txt", "png"] {
            assert!(!takes(ArtKind::Portrait, Path::new(file)) && !takes(ArtKind::Trailer, Path::new(file)), "{file}");
        }
    }

    #[test]
    fn own_files_show_in_place_of_their_kinds_only() {
        let steam = Art { portrait: Some("steam.jpg".into()), hero: Some("hero.jpg".into()), logo: None };
        let own = OwnArt { portrait: Some("mine.png".into()), logo: Some("logo.webp".into()), ..OwnArt::default() };
        let shown =
            Art { portrait: Some("mine.png".into()), hero: Some("hero.jpg".into()), logo: Some("logo.webp".into()) };
        assert_eq!(over(steam.clone(), &own), shown);
        assert_eq!(over(steam.clone(), &OwnArt::default()), steam);
    }

    #[test]
    fn names_stay_inside_the_folder() {
        let dir = Path::new(r"C:\Users\player\AppData\Local\lamplit\art\own");
        let names = BTreeMap::from([
            (ArtKind::Portrait, "portrait-1.png".to_string()),
            (ArtKind::Hero, r"..\..\elsewhere.png".to_string()),
            (ArtKind::Trailer, r"C:\Users\player\Videos\trailer.mp4".to_string()),
        ]);
        let own = paths_in(dir, &names);
        assert_eq!(own.portrait.as_deref(), Some(r"C:\Users\player\AppData\Local\lamplit\art\own\portrait-1.png"));
        assert_eq!((own.hero, own.logo, own.trailer), (None, None, None));
    }

    #[test]
    fn copies_a_file_in_and_refuses_what_it_cant_show() {
        let root = std::env::temp_dir().join(format!("lamplit-test-own-art-{}", std::process::id()));
        let own = root.join("own");
        std::fs::create_dir_all(&root).unwrap();
        let cover = root.join("Cover Art.PNG");
        std::fs::write(&cover, b"\x89PNG").unwrap();
        let name = copy_into(&own, ArtKind::Portrait, &cover).unwrap();
        assert!(name.starts_with("portrait-") && name.ends_with(".png"), "{name}");
        assert_eq!(std::fs::read(own.join(&name)).unwrap(), b"\x89PNG");
        // The copy stays when the original goes.
        std::fs::remove_file(&cover).unwrap();
        assert!(own.join(&name).is_file());
        remove_from(&own, &name);
        assert!(!own.join(&name).exists());

        let message = |r: Result<String>| match r {
            Err(Error::Player(m)) => m,
            other => panic!("expected a message for the player, got {other:?}"),
        };
        let gone = message(copy_into(&own, ArtKind::Trailer, &root.join("gone.mp4")));
        assert!(gone.contains("isn't a video Lamplit can play"), "{gone}");
        std::fs::write(root.join("clip.mkv"), b"x").unwrap();
        assert!(message(copy_into(&own, ArtKind::Trailer, &root.join("clip.mkv"))).contains("isn't a video"));
        let nas = message(copy_into(&own, ArtKind::Logo, Path::new(r"\\nas\art\logo.png")));
        assert!(nas.contains("isn't a picture Lamplit can show"), "{nas}");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
