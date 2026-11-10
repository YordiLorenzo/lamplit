// Steam's About data, cached for seven days. The cache keeps Steam URLs; only the IPC answer replaces images with
// asset URLs after downloading them under art, whose scope already lets the page read them.

use super::Library;
use super::art::{SteamStore, details_appid};
use crate::data;
use crate::error::{Error, Result};
use crate::files::{nonempty, write_atomic};
use crate::prefs;
use html5ever::tokenizer::{BufferQueue, Token, TokenSink, TokenSinkResult, Tokenizer};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewWindow};

const FRESH_SECS: u64 = 7 * 86_400;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Screenshot {
    pub thumb: String,
    pub full: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Trailer {
    pub url: String,
    pub poster: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Details {
    pub appid: u32,
    pub description: String,
    pub developers: Vec<String>,
    pub publishers: Vec<String>,
    pub released: String,
    pub genres: Vec<String>,
    pub screenshots: Vec<Screenshot>,
    pub trailer: Option<Trailer>,
}

#[derive(Serialize, Deserialize)]
struct Cache {
    fetched: u64,
    details: Option<Details>,
}

/// One fetch at a time: a quick close and reopen must not write the same atomic-write temporary file twice.
static FETCH: Mutex<()> = Mutex::new(());

pub fn get(app: &AppHandle, id: &str) -> Result<Option<Details>> {
    let _fetch = FETCH.lock();
    if !prefs::get(app).online_art {
        return Ok(None);
    }
    let Some(game) = app.state::<Library>().game(id) else { return Ok(None) };
    let Some(appid) = details_appid(&game) else { return Ok(None) };
    let mut store = SteamStore::new(app);
    let result = fetch(app, appid, &mut store);
    // A setting changed during an HTTP request takes effect before anything reaches the page.
    if prefs::get(app).online_art { result } else { Ok(None) }
}

fn fetch(app: &AppHandle, appid: u32, store: &mut SteamStore) -> Result<Option<Details>> {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let name = format!("details/{appid}.json");
    let cached: Option<Cache> = data::load(&name)?;
    let details = if let Some(cache) = cached.filter(|c| fresh(c.fetched, now)) {
        cache.details
    } else {
        if !store.online() {
            return Ok(None);
        }
        let body = store.details(appid).map_err(|e| failed(store, "appdetails", &e))?;
        if !store.online() {
            return Ok(None);
        }
        let details = parse(appid, &body)?;
        std::fs::create_dir_all(data::data_dir().join("details"))?;
        data::save(&name, &Cache { fetched: now, details: details.clone() })?;
        details
    };
    let Some(mut details) = details else { return Ok(None) };
    let window = app.get_webview_window("main").ok_or(tauri::Error::WindowNotFound)?;
    let dir = data::data_dir().join("art").join(appid.to_string()).join("screens");
    std::fs::create_dir_all(&dir)?;
    let mut screenshots = Vec::new();
    for screenshot in details.screenshots {
        let thumb = image(store, &window, &dir, &screenshot.thumb)?;
        let full = image(store, &window, &dir, &screenshot.full)?;
        if let (Some(thumb), Some(full)) = (thumb, full) {
            screenshots.push(Screenshot { thumb, full });
        }
    }
    details.screenshots = screenshots;
    if let Some(trailer) = details.trailer.take() {
        details.trailer = image(store, &window, &dir, &trailer.poster)?.map(|poster| Trailer { poster, ..trailer });
    }
    Ok(Some(details))
}

fn fresh(fetched: u64, now: u64) -> bool {
    now.saturating_sub(fetched) < FRESH_SECS
}

fn failed(store: &mut SteamStore, what: &str, error: &ureq::Error) -> Error {
    store.failed(what, error);
    Error::Player("Steam's store didn't answer. Try again in a moment.".into())
}

fn image(store: &mut SteamStore, window: &WebviewWindow, dir: &Path, url: &str) -> Result<Option<String>> {
    if !store.online() {
        return Ok(None);
    }
    // A URL's hash keeps refreshed screenshots separate from older ones without trusting a remote file name.
    let mut hash = DefaultHasher::new();
    url.hash(&mut hash);
    let path = dir.join(format!("{:016x}.jpg", hash.finish()));
    if !nonempty(&path) {
        // A screenshot that fails to download is left out; the next opening tries it again.
        let bytes = match store.image(url) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => return Ok(None),
            Err(e) => {
                store.failed(url, &e);
                return Ok(None);
            }
        };
        if !store.online() {
            return Ok(None);
        }
        write_atomic(&path, &bytes)?;
    }
    Ok(Some(window.convert_file_src(&path, None)?))
}

fn parse(appid: u32, body: &Value) -> Result<Option<Details>> {
    let entry = &body[appid.to_string()];
    if entry["success"] == false {
        return Ok(None);
    }
    let data = &entry["data"];
    if entry["success"] != true || !data.is_object() {
        return Err(Error::Internal(format!("Steam appdetails for {appid} has no data")));
    }
    let strings =
        |key: &str| data[key].as_array().into_iter().flatten().filter_map(Value::as_str).map(plain_text).collect();
    let screenshots = data["screenshots"]
        .as_array()
        .into_iter()
        .flatten()
        .take(8)
        .filter_map(|s| Some(Screenshot { thumb: image_url(&s["path_thumbnail"])?, full: image_url(&s["path_full"])? }))
        .collect();
    Ok(Some(Details {
        appid,
        description: plain_text(data["short_description"].as_str().unwrap_or_default()),
        developers: strings("developers"),
        publishers: strings("publishers"),
        released: plain_text(data["release_date"]["date"].as_str().unwrap_or_default()),
        genres: data["genres"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|g| g["description"].as_str().map(plain_text))
            .collect(),
        screenshots,
        trailer: trailer(&data["movies"]),
    }))
}

/// Store responses name Steam CDNs. Do not turn an unexpected host into a request from the player's PC.
fn steam_url(value: &Value) -> Option<tauri::Url> {
    let url = tauri::Url::parse(value.as_str()?).ok()?;
    let host = url.host_str()?;
    (url.scheme() == "https"
        && (host.ends_with(".steamstatic.com") || host == "steamcdn-a.akamaihd.net")
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}

fn image_url(value: &Value) -> Option<String> {
    steam_url(value).map(Into::into)
}

fn trailer(movies: &Value) -> Option<Trailer> {
    let movies = movies.as_array()?;
    let movie = movies.iter().find(|m| m["highlight"] == true).or_else(|| movies.first())?;
    let url = steam_url(&movie["dash_h264"])?;
    if !matches!(url.host_str(), Some("video.akamai.steamstatic.com" | "video.fastly.steamstatic.com"))
        || url.port().is_some()
    {
        return None;
    }
    Some(Trailer { url: url.into(), poster: image_url(&movie["thumbnail"])? })
}

#[derive(Default)]
struct Text(RefCell<String>);

impl TokenSink for Text {
    type Handle = ();

    fn process_token(&self, token: Token, _line_number: u64) -> TokenSinkResult<()> {
        match token {
            Token::CharacterTokens(text) => self.0.borrow_mut().push_str(&text),
            Token::TagToken(tag) if matches!(tag.name.as_ref(), "br" | "p" | "div" | "li") => {
                self.0.borrow_mut().push(' ');
            }
            _ => {}
        }
        TokenSinkResult::Continue
    }
}

fn plain_text(html: &str) -> String {
    let input = BufferQueue::default();
    input.push_back(html.into());
    let tokenizer = Tokenizer::new(Text::default(), html5ever::tokenizer::TokenizerOpts::default());
    let _ = tokenizer.feed(&input);
    tokenizer.end();
    tokenizer.sink.0.into_inner().split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn current_store_data_has_screenshots_and_the_highlighted_h264_manifest() {
        // Steam appdetails for 1245620, fetched 2026-11-10; unrelated store fields removed.
        let body = serde_json::from_str(include_str!("../../tests/appdetails-1245620.json")).unwrap();
        let details = parse(1_245_620, &body).unwrap().unwrap();
        assert!(details.description.starts_with("THE CRITICALLY ACCLAIMED"));
        assert_eq!(details.developers, ["FromSoftware, Inc."]);
        assert_eq!(details.released, "24 Feb, 2022");
        assert_eq!(details.genres, ["Action", "RPG"]);
        assert_eq!(details.screenshots.len(), 8);
        assert!(details.screenshots[0].full.starts_with("https://shared."));
        let movie = &body["1245620"]["data"]["movies"][0];
        assert_eq!(movie["highlight"], true);
        let trailer = details.trailer.unwrap();
        assert_eq!(trailer.url, movie["dash_h264"].as_str().unwrap());
        assert_eq!(trailer.poster, movie["thumbnail"].as_str().unwrap());
    }

    #[test]
    fn only_the_first_eight_screenshots_are_kept() {
        let shot = json!({
            "path_thumbnail": "https://shared.steamstatic.com/thumb.jpg",
            "path_full": "https://shared.steamstatic.com/full.jpg"
        });
        let mut body = json!({"70": {"success": true, "data": {"screenshots": vec![shot; 9]}}});
        assert_eq!(parse(70, &body).unwrap().unwrap().screenshots.len(), 8);
        body["70"]["data"]["screenshots"][0]["path_full"] = json!("https://elsewhere.test/full.jpg");
        assert_eq!(parse(70, &body).unwrap().unwrap().screenshots.len(), 7);
    }

    #[test]
    fn unavailable_is_not_a_malformed_answer() {
        assert_eq!(parse(70, &json!({"70": {"success": false}})).unwrap(), None);
        assert!(parse(70, &json!({})).is_err());
        assert!(parse(70, &json!({"70": {"success": true}})).is_err());
    }

    #[test]
    fn descriptions_are_text_with_decoded_entities() {
        assert_eq!(
            plain_text("<b>Rock &amp; roll</b><br>It&#39;s&nbsp;alive &#x1F525; &copy;"),
            "Rock & roll It's alive 🔥 ©"
        );
        assert_eq!(plain_text("&lt;player&gt; <!-- hidden --> &quot;Hi&quot;"), "<player> \"Hi\"");
    }

    #[test]
    fn trailers_use_the_first_highlight_or_the_first_movie() {
        let poster = "https://shared.steamstatic.com/poster.jpg";
        let first = "https://video.fastly.steamstatic.com/store_trailers/first.mpd?t=1";
        let highlight = "https://video.akamai.steamstatic.com/store_trailers/highlight.mpd";
        let mut movies = json!([
            {"thumbnail": poster, "dash_h264": first},
            {"highlight": true, "thumbnail": poster, "dash_h264": highlight},
            {"highlight": true, "thumbnail": poster, "dash_h264": first}
        ]);
        assert_eq!(trailer(&movies).unwrap(), Trailer { url: highlight.into(), poster: poster.into() });
        movies[1]["highlight"] = json!(false);
        movies[2]["highlight"] = json!(false);
        assert_eq!(trailer(&movies).unwrap().url, first);
    }

    #[test]
    fn trailers_need_h264_dash_on_the_selected_movie() {
        let poster = "https://shared.steamstatic.com/poster.jpg";
        let mut movies = json!([
            {"thumbnail": poster, "dash_h264": "https://video.fastly.steamstatic.com/first.mpd"},
            {
                "highlight": true,
                "thumbnail": poster,
                "hls_h264": "https://video.fastly.steamstatic.com/master.m3u8",
                "dash_av1": "https://video.fastly.steamstatic.com/av1.mpd",
                "mp4": {"max": "https://video.fastly.steamstatic.com/movie.mp4"}
            }
        ]);
        assert_eq!(trailer(&movies), None);
        movies[1]["dash_h264"] = Value::Null;
        assert_eq!(trailer(&movies), None);
        assert_eq!(trailer(&json!([])), None);
        assert_eq!(trailer(&Value::Null), None);
    }

    #[test]
    fn trailer_manifests_only_use_the_two_https_video_hosts() {
        let movie = |url: &str| json!([{"thumbnail": "https://shared.steamstatic.com/poster.jpg", "dash_h264": url}]);
        for host in ["video.akamai.steamstatic.com", "video.fastly.steamstatic.com"] {
            let url = format!("https://{host}/store_trailers/dash_h264.mpd?t=1");
            assert_eq!(trailer(&movie(&url)).unwrap().url, url);
        }
        for url in [
            "http://video.akamai.steamstatic.com/movie.mpd",
            "https://shared.steamstatic.com/movie.mpd",
            "https://video.other.steamstatic.com/movie.mpd",
            "https://video.fastly.steamstatic.com.evil.test/movie.mpd",
            "https://video.fastly.steamstatic.com:444/movie.mpd",
            "https://user@video.fastly.steamstatic.com/movie.mpd",
            "file:///C:/movie.mpd",
        ] {
            assert_eq!(trailer(&movie(url)), None, "{url}");
        }
    }

    #[test]
    fn cache_expires_at_seven_days() {
        assert!(fresh(100, 100 + FRESH_SECS - 1));
        assert!(!fresh(100, 100 + FRESH_SECS));
    }

    #[test]
    fn payload_matches_the_page_fixture() {
        let asset = "http://asset.localhost/C%3A%5Clamplit%5Cart%5C1245620%5Cscreens%5C";
        let details = Details {
            appid: 1_245_620,
            description: "Rise, Tarnished, and be guided by grace to brandish the power of the Elden Ring.".into(),
            developers: vec!["FromSoftware, Inc.".into()],
            publishers: vec!["Bandai Namco Entertainment Inc.".into()],
            released: "24 Feb, 2022".into(),
            genres: vec!["Action".into(), "RPG".into()],
            screenshots: vec![Screenshot { thumb: format!("{asset}thumb.jpg"), full: format!("{asset}full.jpg") }],
            trailer: Some(Trailer {
                url: "https://video.fastly.steamstatic.com/store_trailers/1245620/dash_h264.mpd".into(),
                poster: format!("{asset}poster.jpg"),
            }),
        };
        assert_eq!(serde_json::to_value(details).unwrap(), ipc_fixture!("details"));
    }
}
