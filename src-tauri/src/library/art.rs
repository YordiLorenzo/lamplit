// Cover, hero and logo art. Steam's own library cache first, then Steam's public store (no key needed) while the
// player lets Lamplit find art online. Games from other stores are matched to their Steam page by name
// (name_match.rs), so their names go to Steam's store search. Downloads and lookups are cached in the data folder
// (art\<appid>\ and art.json).

use super::name_match;
use super::{Art, Game};
use crate::data::{self, data_dir};
use crate::events::{self, Event};
use crate::files::{nonempty, write_atomic};
use crate::prefs;
use crate::stores::steam;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// How long a name that matched nothing, or art the store didn't have, waits before Lamplit asks again.
const RETRY_SECS: u64 = 7 * 86_400;
const CDN: &str = "https://shared.steamstatic.com/store_item_assets/";
/// The most appids one GetItems call asks about. They travel in the URL, which servers cap at about 8 KB.
const ITEMS_PER_CALL: usize = 50;

#[derive(Default, Serialize, Deserialize)]
struct Db {
    /// Game id → Steam appid found by name (None = searched, nothing matched).
    lookups: HashMap<String, Lookup>,
    /// Appid → when its art was last fetched from the store.
    fetched: HashMap<u32, u64>,
}

#[derive(Serialize, Deserialize)]
struct Lookup {
    appid: Option<u32>,
    at: u64,
}

const DB: &str = "art.json";

fn load() -> Db {
    data::load_or_default(DB)
}

fn save(db: &Db) {
    if let Err(e) = data::save(DB, db) {
        log::warn!("art: can't save {DB}: {e}");
    }
}

/// The art Lamplit downloads, one folder per Steam app id.
fn downloads() -> PathBuf {
    data_dir().join("art")
}

/// Steam's own library art, one folder per app id.
fn steam_library_cache() -> Option<PathBuf> {
    steam::path().map(|root| root.join(r"appcache\librarycache"))
}

/// Lets the page load files from the two folders art comes from. tauri.conf.json gives the asset protocol no
/// folder at all, so the page can't read anything else on the PC. Runs with every scan, so a Steam installed while
/// Lamplit runs is covered too.
pub fn open_folders_to_page(app: &AppHandle) -> tauri::Result<()> {
    let scope = app.asset_protocol_scope();
    scope.allow_directory(downloads(), true)?;
    if let Some(cache) = steam_library_cache() {
        scope.allow_directory(cache, true)?;
    }
    Ok(())
}

fn art_dir(appid: u32) -> PathBuf {
    downloads().join(appid.to_string())
}

fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Steam keeps library art in `<cache>\<appid>\`, newer files in a hash subfolder. An empty file there shows nothing,
/// so Lamplit downloads its own copy instead.
fn steam_cache(cache: &Path, appid: u32) -> Art {
    let mut files: HashMap<String, PathBuf> = HashMap::new();
    let mut dirs = vec![cache.join(appid.to_string())];
    while let Some(d) = dirs.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                dirs.push(e.path());
            } else if meta.len() > 0 {
                files.insert(e.file_name().to_string_lossy().to_lowercase(), e.path());
            }
        }
    }
    let pick = |names: &[&str]| names.iter().find_map(|n| files.get(*n)).map(|p| path_string(p));
    Art {
        portrait: pick(&[
            "library_600x900_2x.jpg", "library_600x900.jpg", "library_capsule_2x.jpg", "library_capsule.jpg",
        ]),
        hero: pick(&["library_hero_2x.jpg", "library_hero.jpg"]),
        logo: pick(&["logo_2x.png", "logo.png"]),
    }
}

fn downloaded(appid: u32) -> Art {
    let dir = art_dir(appid);
    let have = |name: &str| {
        let p = dir.join(name);
        nonempty(&p).then(|| path_string(&p))
    };
    Art { portrait: have("portrait.jpg"), hero: have("hero.jpg"), logo: have("logo.png") }
}

/// The art on disk for `appid`: Steam's library cache (`cache`, when Steam is installed) first, then Lamplit's own.
fn local(cache: Option<&Path>, appid: u32) -> Art {
    let (a, b) = (cache.map(|c| steam_cache(c, appid)).unwrap_or_default(), downloaded(appid));
    Art { portrait: a.portrait.or(b.portrait), hero: a.hero.or(b.hero), logo: a.logo.or(b.logo) }
}

fn complete(art: &Art) -> bool {
    art.portrait.is_some() && art.hero.is_some() && art.logo.is_some()
}

/// Art already on disk, without touching the network, so the list shows at once.
pub fn from_disk(games: &mut [Game]) {
    let (db, cache) = (load(), steam_library_cache());
    for g in games {
        if let Some(appid) = g.steam_appid.or_else(|| db.lookups.get(&g.id).and_then(|l| l.appid)) {
            g.art = local(cache.as_deref(), appid);
        }
    }
}

/// Fetches the art still missing from Steam's store, and puts it in the library and tells the page, game by game.
pub fn fetch_missing(app: &AppHandle, games: &[Game]) {
    let mut store = SteamStore::new(app);
    let mut db = load();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let appids = appids_for(games, &mut db, &mut store, now);
    save(&db);

    let cache = steam_library_cache();
    let mut art: HashMap<u32, Art> = appids.iter().flatten().map(|&a| (a, local(cache.as_deref(), a))).collect();
    let mut need: HashSet<u32> = art
        .iter()
        .filter(|(a, have)| !complete(have) && db.fetched.get(a).is_none_or(|t| now.saturating_sub(*t) >= RETRY_SECS))
        .map(|(a, _)| *a)
        .collect();
    let (assets, answered) = store.assets(&need);

    for (g, appid) in games.iter().zip(appids) {
        let Some(appid) = appid else { continue };
        if need.remove(&appid) && store.online() {
            // Remember the attempt only when the store answered: until then the next scan tries again.
            if download(&mut store, appid, &art[&appid], assets.get(&appid)) && answered.contains(&appid) {
                db.fetched.insert(appid, now);
            }
            art.insert(appid, local(cache.as_deref(), appid));
        }
        let found = &art[&appid];
        if *found != g.art {
            app.state::<super::Library>().set_art(&g.id, found);
            events::emit(app, Event::Art { id: &g.id, art: found });
        }
    }
    save(&db);
}

/// Each game's Steam appid: its own, else one an earlier scan found by name, else a search now. A name that matched
/// nothing is searched again after RETRY_SECS.
fn appids_for(games: &[Game], db: &mut Db, store: &mut SteamStore, now: u64) -> Vec<Option<u32>> {
    let mut appids = Vec::with_capacity(games.len());
    for g in games {
        let known = db.lookups.get(&g.id).filter(|l| l.appid.is_some() || now.saturating_sub(l.at) < RETRY_SECS);
        let appid = match (g.steam_appid, known) {
            (Some(a), _) => Some(a),
            (None, Some(l)) => l.appid,
            (None, None) if !store.online() => None,
            (None, None) => match store.search(&g.name) {
                Ok(found) => {
                    log::info!("art: {} → Steam appid {found:?}", g.name);
                    db.lookups.insert(g.id.clone(), Lookup { appid: found, at: now });
                    found
                }
                // Nothing is remembered, so the next scan tries again.
                Err(e) => {
                    store.failed(&format!("lookup for {}", g.name), &e);
                    None
                }
            },
        };
        appids.push(appid);
    }
    appids
}

/// Downloads the files `have` lacks. False when one may still come: a request failed, the pass stopped going online,
/// or a file couldn't be saved.
fn download(store: &mut SteamStore, appid: u32, have: &Art, assets: Option<&Assets>) -> bool {
    let dir = art_dir(appid);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("art: can't make {}: {e}", dir.display());
        return false;
    }
    let mut settled = true;
    for (file, urls) in candidate_urls(appid, have, assets) {
        let mut got = None;
        for url in &urls {
            if !store.online() {
                return false;
            }
            match store.image(url) {
                Ok(Some(bytes)) => {
                    got = Some(bytes);
                    break;
                }
                Ok(None) => {}
                Err(e) => {
                    store.failed(url, &e);
                    settled = false;
                }
            }
        }
        match got {
            Some(bytes) => {
                if let Err(e) = write_atomic(&dir.join(file), &bytes) {
                    log::warn!("art: can't save {file} for appid {appid}: {e}");
                    settled = false;
                }
            }
            None => log::info!("art: no {file} for appid {appid}"),
        }
    }
    settled
}

/// The files to download for `appid` (those `have` lacks), each with the URLs to try in turn: the store's current
/// file, then the fixed paths older games still use.
fn candidate_urls(appid: u32, have: &Art, assets: Option<&Assets>) -> Vec<(&'static str, Vec<String>)> {
    let legacy = |file: &str| format!("{CDN}steam/apps/{appid}/{file}");
    let with_legacy =
        |current: Option<&String>, file: &str| current.cloned().into_iter().chain([legacy(file)]).collect();
    let mut out = Vec::new();
    if have.portrait.is_none() {
        out.push(("portrait.jpg", with_legacy(assets.and_then(|a| a.portrait.as_ref()), "library_600x900_2x.jpg")));
    }
    if have.hero.is_none() {
        out.push(("hero.jpg", with_legacy(assets.and_then(|a| a.hero.as_ref()), "library_hero.jpg")));
    }
    if have.logo.is_none() {
        out.push(("logo.png", vec![legacy("logo_2x.png"), legacy("logo.png")]));
    }
    out
}

/// A store item's art, as URLs.
#[derive(Debug, PartialEq)]
struct Assets {
    portrait: Option<String>,
    hero: Option<String>,
}

/// The art in a GetItems answer, by appid. Each item names its files and one URL pattern for them.
fn parse_store_items(body: &serde_json::Value) -> HashMap<u32, Assets> {
    let mut out = HashMap::new();
    for item in body["response"]["store_items"].as_array().into_iter().flatten() {
        let assets = &item["assets"];
        let (Some(appid), Some(format)) = (item["appid"].as_u64(), assets["asset_url_format"].as_str()) else {
            continue;
        };
        let url = |keys: &[&str]| {
            let file = keys.iter().find_map(|k| assets[*k].as_str())?;
            Some(format!("{CDN}{}", format.replace("${FILENAME}", file)))
        };
        out.insert(
            appid as u32,
            Assets {
                portrait: url(&["library_capsule_2x", "library_capsule"]),
                hero: url(&["library_hero_2x", "library_hero"]),
            },
        );
    }
    out
}

/// Steam's public store, for one pass. The first request that can't reach Steam (no network, DNS failing, no
/// connection) ends the pass's network work, so a dead connection costs one timeout rather than one per game; the
/// next scan tries again. Any other failure (an error from Steam, a download that stalls) affects only its own
/// request. The pass also stops going online once the player switches online art off.
struct SteamStore {
    app: AppHandle,
    agent: ureq::Agent,
    /// The store's country (listings differ per country), from the player's Windows region.
    country: String,
    offline: bool,
}

impl SteamStore {
    fn new(app: &AppHandle) -> Self {
        let agent = ureq::Agent::config_builder()
            // Reaching Steam takes well under a second on a working network.
            .timeout_resolve(Some(Duration::from_secs(10)))
            .timeout_connect(Some(Duration::from_secs(10)))
            // A large image may take minutes while Steam downloads a game at full speed; one that sends nothing for
            // 20 s has stalled.
            .timeout_per_read(Some(Duration::from_secs(20)))
            .timeout_global(Some(Duration::from_mins(5)))
            .user_agent(concat!(env!("CARGO_PKG_NAME"), "/", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        SteamStore { app: app.clone(), agent, country: steam::store_country(), offline: false }
    }

    /// Steam has been reachable so far, and the player still lets Lamplit find art online.
    fn online(&self) -> bool {
        !self.offline && prefs::get(&self.app).online_art
    }

    fn failed(&mut self, what: &str, e: &ureq::Error) {
        log::warn!("art: {what} failed: {e}");
        if unreachable(e) && !self.offline {
            log::warn!("art: Steam can't be reached, so no more art until the next scan");
            self.offline = true;
        }
    }

    /// The game's Steam appid, Ok(None) when Steam has no such game.
    fn search(&self, name: &str) -> Result<Option<u32>, ureq::Error> {
        for q in name_match::queries(name) {
            let body: serde_json::Value = self
                .agent
                .get("https://store.steampowered.com/api/storesearch/")
                .query("term", &q)
                .query("l", "english")
                .query("cc", &self.country)
                .call()?
                .body_mut()
                .read_json()?;
            let items: Vec<(u32, String)> = body["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|i| Some((i["id"].as_u64()? as u32, i["name"].as_str()?.to_string())))
                .collect();
            if let Some(id) = name_match::best_match(name, &items) {
                return Ok(Some(id));
            }
        }
        Ok(None)
    }

    /// The art URLs of the `appids` Steam answered for, and those appids, from GetItems calls of ITEMS_PER_CALL each.
    fn assets(&mut self, appids: &HashSet<u32>) -> (HashMap<u32, Assets>, HashSet<u32>) {
        let (mut assets, mut answered) = (HashMap::new(), HashSet::new());
        let appids: Vec<u32> = appids.iter().copied().collect();
        for chunk in appids.chunks(ITEMS_PER_CALL) {
            if !self.online() {
                break;
            }
            match self.items(chunk) {
                Ok(found) => {
                    assets.extend(found);
                    answered.extend(chunk);
                }
                Err(e) => self.failed("store GetItems", &e),
            }
        }
        (assets, answered)
    }

    fn items(&self, appids: &[u32]) -> Result<HashMap<u32, Assets>, ureq::Error> {
        let input = serde_json::json!({
            "ids": appids.iter().map(|a| serde_json::json!({ "appid": a })).collect::<Vec<_>>(),
            "context": { "language": "english", "country_code": self.country },
            "data_request": { "include_assets": true },
        });
        let body: serde_json::Value = self
            .agent
            .get("https://api.steampowered.com/IStoreBrowseService/GetItems/v1/")
            .query("input_json", input.to_string())
            .call()?
            .body_mut()
            .read_json()?;
        Ok(parse_store_items(&body))
    }

    /// A JPEG or PNG, Ok(None) when the store has no such file.
    fn image(&self, url: &str) -> Result<Option<Vec<u8>>, ureq::Error> {
        let mut resp = match self.agent.get(url).call() {
            Ok(r) => r,
            Err(ureq::Error::StatusCode(404 | 403 | 410)) => return Ok(None),
            Err(e) => return Err(e),
        };
        let bytes = resp.body_mut().with_config().limit(25 * 1024 * 1024).read_to_vec()?;
        let image = bytes.starts_with(&[0xFF, 0xD8]) || bytes.starts_with(&[0x89, b'P', b'N', b'G']);
        Ok(image.then_some(bytes))
    }
}

/// The request never reached Steam: no network, no DNS, or no connection. Every other error concerns one request.
fn unreachable(e: &ureq::Error) -> bool {
    use std::io::ErrorKind;
    match e {
        ureq::Error::HostNotFound | ureq::Error::ConnectionFailed => true,
        ureq::Error::Timeout(t) => matches!(t, ureq::Timeout::Resolve | ureq::Timeout::Connect),
        // What a connect that fails at once reports.
        ureq::Error::Io(e) => matches!(
            e.kind(),
            ErrorKind::ConnectionRefused
                | ErrorKind::HostUnreachable
                | ErrorKind::NetworkUnreachable
                | ErrorKind::NetworkDown
                | ErrorKind::AddrNotAvailable
        ),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_failed_connection_ends_the_pass() {
        assert!(unreachable(&ureq::Error::HostNotFound));
        assert!(unreachable(&ureq::Error::Timeout(ureq::Timeout::Connect)));
        assert!(unreachable(&ureq::Error::Io(std::io::ErrorKind::NetworkUnreachable.into())));
        // A slow or broken download is that file's problem; the other games still get their art.
        assert!(!unreachable(&ureq::Error::Timeout(ureq::Timeout::PerRead)));
        assert!(!unreachable(&ureq::Error::Timeout(ureq::Timeout::Global)));
        assert!(!unreachable(&ureq::Error::BodyStalled));
        assert!(!unreachable(&ureq::Error::Io(std::io::ErrorKind::ConnectionReset.into())));
        assert!(!unreachable(&ureq::Error::StatusCode(503)));
    }

    #[test]
    fn store_items_give_art_urls() {
        let body = json!({ "response": { "store_items": [
            { "appid": 10, "assets": {
                "asset_url_format": "steam/apps/10/abc/${FILENAME}?t=1",
                "library_capsule": "library_600x900.jpg",
                "library_capsule_2x": "library_600x900_2x.jpg",
                "library_hero": "library_hero.jpg",
            } },
            // Only the 1x files.
            { "appid": 20, "assets": { "asset_url_format": "steam/apps/20/${FILENAME}", "library_capsule": "c.jpg" } },
            // No assets at all: Steam knows the app but has no art for it.
            { "appid": 30 },
        ] } });
        let found = parse_store_items(&body);
        assert_eq!(
            found[&10],
            Assets {
                portrait: Some(format!("{CDN}steam/apps/10/abc/library_600x900_2x.jpg?t=1")),
                hero: Some(format!("{CDN}steam/apps/10/abc/library_hero.jpg?t=1")),
            }
        );
        assert_eq!(found[&20], Assets { portrait: Some(format!("{CDN}steam/apps/20/c.jpg")), hero: None });
        assert!(!found.contains_key(&30));
        assert!(parse_store_items(&json!({})).is_empty());
    }

    #[test]
    fn only_missing_files_are_fetched_newest_url_first() {
        let assets = Assets { portrait: Some("https://cdn/p.jpg".into()), hero: None };
        let have = Art { portrait: None, hero: None, logo: Some("logo.png".into()) };
        assert_eq!(
            candidate_urls(7, &have, Some(&assets)),
            vec![
                ("portrait.jpg", vec!["https://cdn/p.jpg".into(), format!("{CDN}steam/apps/7/library_600x900_2x.jpg")]),
                ("hero.jpg", vec![format!("{CDN}steam/apps/7/library_hero.jpg")]),
            ]
        );
        let none = Art::default();
        let urls: Vec<&str> = candidate_urls(7, &none, None).iter().map(|(file, _)| *file).collect();
        assert_eq!(urls, ["portrait.jpg", "hero.jpg", "logo.png"]);
    }
}
