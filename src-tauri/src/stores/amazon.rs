// The Amazon Games app: where it is, and its games, from the database it keeps them in (GameInstallInfo.sqlite, the
// file Playnite's Amazon library reads too). Games start through the app's `amazon-games://play/<id>` link.

use super::names::{clean_name, prettify};
use super::{Store, read, sqlite};
use crate::error::Result;
use crate::files::{file_name, local_app_data, on_a_drive};
use crate::library::{Game, Launch};
use std::path::{Path, PathBuf};

/// The app installs for the player's Windows account only, always into this folder.
pub fn exe() -> PathBuf {
    local_app_data().join(r"Amazon Games\App\Amazon Games.exe")
}

pub fn games() -> Result<Vec<Game>> {
    let db = local_app_data().join(r"Amazon Games\Data\Games\Sql\GameInstallInfo.sqlite");
    let mut out = Vec::new();
    for (id, title, dir) in installs(&db)? {
        if !on_a_drive(&dir) || !read::is_dir(&dir)? {
            log::info!("discovery amazon: {} skipped, {} is missing", title.as_deref().unwrap_or(&id), dir.display());
            continue;
        }
        let name = title.map_or_else(|| prettify(&file_name(&dir)), |t| clean_name(&t));
        let link = format!("amazon-games://play/{id}");
        out.push(Game::new(format!("amazon:{id}"), name, Some(Store::Amazon), dir, Launch::Uri(link)));
    }
    Ok(out)
}

/// The games the app has installed (table DbSet, `Installed` 1): id, title and folder.
fn installs(db: &Path) -> Result<Vec<(String, Option<String>, PathBuf)>> {
    let Some(db) = sqlite::Db::open(db)? else { return Ok(Vec::new()) };
    let rows = db.rows("DbSet")?;
    Ok(rows
        .iter()
        .filter(|r| r.int("Installed") == Some(1))
        .filter_map(|r| {
            let id = r.text("Id").filter(|id| !id.is_empty())?;
            let dir = r.text("InstallDirectory").filter(|d| !d.is_empty())?;
            Some((id.to_string(), r.text("ProductTitle").map(str::to_string), PathBuf::from(dir)))
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stores::sqlite::fixtures::AMAZON;

    #[test]
    fn installed_games_from_the_apps_database() {
        let dir = std::env::temp_dir().join(format!("lamplit-test-amazon-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("GameInstallInfo.sqlite");
        std::fs::write(&db, AMAZON).unwrap();
        let list = installs(&db).unwrap();
        let ids: Vec<&str> = list.iter().map(|(id, ..)| id.as_str()).collect();
        // Not the one the app lists as uninstalled.
        assert_eq!(ids, ["amzn1.adg.product.0001", "amzn1.adg.product.0002", "amzn1.adg.product.0004"]);
        assert_eq!(list[0].1.as_deref(), Some("Fennel™"));
        assert_eq!(list[1].2, PathBuf::from(r"D:\Games\Amazon\Thistle\"));
        // The share in the last row is never followed: games() checks each folder with on_a_drive.
        assert!(!on_a_drive(&list[2].2));
        assert!(installs(&dir.join("missing.sqlite")).unwrap().is_empty());
        std::fs::write(&db, "cut off database").unwrap();
        assert!(installs(&db).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
