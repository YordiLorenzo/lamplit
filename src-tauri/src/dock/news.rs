// What the folded dock shows on its own for a moment, over a game: the headset turned on or off, a controller
// connected or gone, a battery running low. Read once a second from what Lamplit already knows about the headset and
// the controllers, which their own threads keep current. Windows shows its own volume indicator, so the dock doesn't.

use crate::devices::accessories::{self, Accessories};
use crate::devices::pad::{Battery, Level};
use crate::devices::{Charge, headset};
use serde::Serialize;
use std::collections::HashSet;
use std::time::Duration;
use tauri::AppHandle;

const EVERY: Duration = Duration::from_secs(1);
/// A battery at this percent or below, running on its battery, is low.
const LOW: u8 = 15;
/// A low battery is told about once, and again only after it has been charged past this.
const RECHARGED: u8 = 25;
/// What the headset is called among the batteries already told about.
const HEADSET: &str = "headset";

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct News {
    pub icon: Icon,
    pub text: String,
    /// A battery running low.
    pub warn: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(strum::VariantArray))]
#[serde(rename_all = "lowercase")]
pub enum Icon {
    Headset,
    Controller,
}

/// News that isn't a warning.
fn note(icon: Icon, text: String) -> News {
    News { icon, text, warn: false }
}

/// Looks once a second, for as long as Lamplit runs.
pub fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        let mut before: Option<Accessories> = None;
        // The batteries whose low level the player has been told about: controller ids, and HEADSET.
        let mut told: HashSet<String> = HashSet::new();
        loop {
            let now = accessories::state(&app);
            told.retain(|key| low_battery(&now, key, RECHARGED).is_some());
            // A battery running low matters most; it waits until the dock can show it.
            let low = batteries(&now).into_iter().find(|(key, _)| !told.contains(key));
            if let Some((key, warning)) = low {
                if super::show_news(&app, &warning) {
                    told.insert(key);
                }
            } else if let Some(change) = before.as_ref().and_then(|before| changes(before, &now).pop()) {
                // A change is news only now: when the dock can't show it, it is gone.
                super::show_news(&app, &change);
            }
            before = Some(now);
            std::thread::sleep(EVERY);
        }
    });
}

/// What changed between two looks: the headset turned on or off, a controller connected or gone.
fn changes(before: &Accessories, now: &Accessories) -> Vec<News> {
    let mut news = Vec::new();
    match (before.headset.on, now.headset.on) {
        (Some(false), Some(true)) => {
            let battery = now.headset.battery.map(|b| format!(" · {b}%")).unwrap_or_default();
            news.push(note(Icon::Headset, format!("Headset on{battery}")));
        }
        (Some(true), Some(false)) => news.push(note(Icon::Headset, "Headset off".into())),
        _ => {}
    }
    let ids = |a: &Accessories| a.controllers.iter().map(|c| c.id.clone()).collect::<HashSet<_>>();
    let (had, has) = (ids(before), ids(now));
    for c in now.controllers.iter().filter(|c| !had.contains(&c.id)) {
        news.push(note(Icon::Controller, format!("{} connected", c.name)));
    }
    for c in before.controllers.iter().filter(|c| !has.contains(&c.id)) {
        news.push(note(Icon::Controller, format!("{} disconnected", c.name)));
    }
    news
}

/// Every battery that is low now, with its key among the batteries told about.
fn batteries(now: &Accessories) -> Vec<(String, News)> {
    let keys = std::iter::once(HEADSET.to_string()).chain(now.controllers.iter().map(|c| c.id.clone()));
    keys.filter_map(|key| low_battery(now, &key, LOW).map(|news| (key, news))).collect()
}

/// The warning for the battery `key` (HEADSET or a controller's id) when it is at `limit` percent or below and not
/// charging. A controller that tells only a rough level (XInput's) is low at Low or Empty.
fn low_battery(now: &Accessories, key: &str, limit: u8) -> Option<News> {
    let warning = |icon, text| Some(News { icon, text, warn: true });
    if key == HEADSET {
        let headset::Status { on, battery, charge, .. } = now.headset;
        return match (on, battery, charge) {
            (Some(true), Some(b), Some(Charge::Battery)) if b <= limit => {
                warning(Icon::Headset, format!("Headset battery low · {b}%"))
            }
            _ => None,
        };
    }
    let c = now.controllers.iter().find(|c| c.id == key)?;
    match c.battery? {
        Battery { percent: Some(p), charge: Some(Charge::Battery) | None, .. } if p <= limit => {
            warning(Icon::Controller, format!("{} battery low · {p}%", c.name))
        }
        Battery { percent: None, level: Some(Level::Low | Level::Empty), .. } => {
            warning(Icon::Controller, format!("{} battery low", c.name))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::devices::pad::{Connection, Controller, Kind};

    fn headset(on: bool, battery: u8, charge: Charge) -> headset::Status {
        headset::Status {
            receiver: true,
            on: Some(on),
            battery: Some(battery),
            charge: Some(charge),
            ..Default::default()
        }
    }

    fn pad(id: &str, name: &str, battery: Option<Battery>) -> Controller {
        Controller {
            id: id.into(),
            kind: Kind::DualSense,
            name: name.into(),
            connection: Connection::Bluetooth,
            battery,
            headphones: None,
            address: None,
        }
    }

    fn texts(news: &[News]) -> Vec<&str> {
        news.iter().map(|n| n.text.as_str()).collect()
    }

    fn seen(headset: headset::Status, controllers: Vec<Controller>) -> Accessories {
        Accessories { headset, controllers }
    }

    #[test]
    fn the_headset_turning_on_and_off_is_news() {
        let off = || seen(headset(false, 80, Charge::Battery), vec![]);
        let on = || seen(headset(true, 80, Charge::Battery), vec![]);
        assert_eq!(texts(&changes(&off(), &on())), ["Headset on · 80%"]);
        assert_eq!(texts(&changes(&on(), &off())), ["Headset off"]);
        // Lamplit learning the headset's state at start is no news.
        assert!(changes(&seen(headset::Status::default(), vec![]), &on()).is_empty());
    }

    #[test]
    fn controllers_coming_and_going_are_news() {
        let none = seen(headset::Status::default(), vec![]);
        let one = || seen(headset::Status::default(), vec![pad("a", "DualSense", None)]);
        let other = seen(headset::Status::default(), vec![pad("b", "Xbox controller", None)]);
        assert_eq!(texts(&changes(&none, &one())), ["DualSense connected"]);
        assert_eq!(texts(&changes(&one(), &other)), ["Xbox controller connected", "DualSense disconnected"]);
        assert!(changes(&one(), &one()).is_empty());
    }

    #[test]
    fn low_batteries_warn_until_charged() {
        let dualsense =
            |p, charge| pad("a", "DualSense", Some(Battery { percent: Some(p), level: None, charge: Some(charge) }));
        let rough = Some(Battery { percent: None, level: Some(Level::Low), charge: None });
        let xbox = Controller { kind: Kind::Xbox, ..pad("x", "Xbox controller", rough) };
        let now = seen(headset(true, 10, Charge::Battery), vec![dualsense(15, Charge::Battery), xbox]);
        let low = batteries(&now);
        let keys: Vec<&str> = low.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["headset", "a", "x"]);
        let warnings: Vec<News> = low.into_iter().map(|(_, n)| n).collect();
        assert_eq!(
            texts(&warnings),
            ["Headset battery low · 10%", "DualSense battery low · 15%", "Xbox controller battery low"]
        );
        assert!(warnings.iter().all(|n| n.warn));
        // Charging, or above the limit, is no warning; a warning told stays told until the battery is past 25%.
        let one = |p, charge| seen(headset::Status::default(), vec![dualsense(p, charge)]);
        assert!(low_battery(&one(5, Charge::Charging), "a", LOW).is_none());
        assert!(low_battery(&one(25, Charge::Battery), "a", LOW).is_none());
        assert!(low_battery(&one(25, Charge::Battery), "a", RECHARGED).is_some());
        assert!(low_battery(&one(35, Charge::Battery), "a", RECHARGED).is_none());
        // A controller that is gone has no battery to warn about, and a headset that is off neither.
        assert!(low_battery(&one(5, Charge::Battery), "gone", LOW).is_none());
        assert!(low_battery(&seen(headset(false, 5, Charge::Battery), vec![]), HEADSET, LOW).is_none());
    }
}
