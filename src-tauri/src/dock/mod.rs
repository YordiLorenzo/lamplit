// The in-game dock. Holding PS (or View and Menu) over a game brings up a small dock along the bottom of the screen
// instead of the whole home screen: volume, sound output, quiet mode, NVIDIA's stats, the home screen, and closing
// the game. It is Lamplit's own window, transparent and above the game; nothing is drawn inside the game.
//
// While it is open the dock takes the foreground, as the home screen does. A window that leaves the game its focus
// (WS_EX_NOACTIVATE) would leave the game reading the controller too: XInput, HID and Steam Input have no notion of
// which app a press is for, so Cross on "Close game" would also jump in the game. Games are expected to stop reading
// the controller while another window is in front (Microsoft's XInputEnable is meant for WM_ACTIVATEAPP), and Steam
// Input switches to its desktop layout. The news the folded dock shows on its own (news.rs) is passive: it never
// takes the focus or the mouse.
//
// Over a game in exclusive full screen Windows shows no other window, and one that takes the foreground makes the
// game leave full screen, so there the home screen comes forward as before. window.rs places the dock's window,
// game.rs closes the game.

mod game;
mod news;
mod window;

pub use game::{GameState, close_game, closed_from_dock, game_state};
pub use news::News;
pub use window::{LABEL, close_with_main};

use crate::error::Result;
use crate::events::{self, Event};
use crate::launch::{self, Launcher};
use crate::prefs;
use crate::win::{self, window::HWND};
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// What the dock's page shows.
#[derive(Clone, Serialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum Show {
    /// The dock springs open over the game, on Resume.
    Open,
    /// The dock folds away.
    Closed,
    /// The folded dock shows news for a moment, without taking the game's focus.
    Status(News),
}

/// Where the dock is now. Changed only on the main thread, which owns the dock's window; read from any thread.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Shown {
    Hidden,
    /// Showing news, until it is hidden again.
    News,
    /// Open over the game. `game` is the window that was in front when it opened, which gets the focus back.
    Open {
        game: isize,
    },
    /// Folding away; the window hides once the page has played the fold.
    Folding,
}

static SHOWN: Mutex<Shown> = Mutex::new(Shown::Hidden);
/// Counts every showing and folding, so the timed hide of an earlier one does nothing.
static SHOWING: AtomicU64 = AtomicU64::new(0);

/// How long the page takes to fold the dock away (dock.css).
const FOLD: Duration = Duration::from_millis(450);
/// How long news shows: the page springs it open, holds it and folds it in this time.
const NEWS_FOR: Duration = Duration::from_millis(3200);

/// The dock's window when the dock is switched on, and the thread that tells news. Runs in Tauri's setup.
pub fn start(app: &AppHandle) {
    if prefs::get(app).dock
        && let Err(e) = window::create(app)
    {
        log::warn!("dock: can't make its window, so holding PS brings the home screen: {e}");
    }
    news::watch(app.clone());
    // A debug build takes keys for holding PS and for news, to try the dock without a controller.
    #[cfg(debug_assertions)]
    {
        let (hold, news) = (app.clone(), app.clone());
        win::dock::on_hotkey(b'D', move || summon(&hold));
        win::dock::on_hotkey(b'N', move || {
            let test = News { icon: news::Icon::Controller, text: "News from a debug build".into(), warn: false };
            show_news(&news, &test);
        });
    }
}

/// Switches the dock on or off: off, holding PS brings the home screen over a game, as it did before the dock.
pub fn set_on(app: &AppHandle, on: bool) -> Result<()> {
    prefs::change(app, |p| p.dock = on)?;
    if on {
        window::create(app)?;
    } else {
        hide(app);
        window::destroy(app);
    }
    log::info!("dock {}", if on { "on" } else { "off" });
    Ok(())
}

/// What holding PS, or View and Menu, finds.
#[derive(Clone, Copy)]
struct Scene {
    dock_open: bool,
    /// The dock is switched on and its window exists.
    dock_on: bool,
    game_runs: bool,
    lamplit_in_front: bool,
    exclusive_full_screen: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Summon {
    /// A second hold folds the dock away, back to the game.
    Fold,
    Dock,
    /// The home screen comes forward, as it always did.
    Home,
}

fn choose(s: Scene) -> Summon {
    if s.dock_open {
        Summon::Fold
    } else if s.dock_on && s.game_runs && !s.lamplit_in_front && !s.exclusive_full_screen {
        Summon::Dock
    } else {
        Summon::Home
    }
}

/// Holding PS, or View and Menu: the dock over a game, or the home screen.
pub fn summon(app: &AppHandle) {
    let scene = Scene {
        dock_open: is_open(),
        dock_on: window::handle().is_some(),
        game_runs: app.state::<Launcher>().running_id().is_some(),
        lamplit_in_front: launch::window::lamplit_in_front(),
        exclusive_full_screen: win::dock::exclusive_full_screen(),
    };
    match choose(scene) {
        Summon::Fold => fold(app, true),
        Summon::Dock => open(app),
        Summon::Home => {
            if scene.dock_on && scene.game_runs && scene.exclusive_full_screen {
                log::info!("dock: the game holds the screen in exclusive full screen; the home screen instead");
            }
            launch::window::summon(app);
        }
    }
}

/// The dock is open, so controller presses are for it. Also when Windows didn't let it take the foreground, from a
/// game that stopped responding: that game can't read them anyway, and Force close is what the player is after.
pub fn is_open() -> bool {
    matches!(*SHOWN.lock(), Shown::Open { .. })
}

fn in_front() -> bool {
    window::handle().is_some_and(|dock| win::window::foreground() == dock)
}

fn open(app: &AppHandle) {
    let shown = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(dock) = window::handle() else { return };
        let game = win::window::foreground();
        window::place(dock, game, window::Size::Open);
        win::window::force_foreground(dock);
        *SHOWN.lock() = Shown::Open { game: game.0 as isize };
        SHOWING.fetch_add(1, Ordering::SeqCst);
        events::emit(&shown, Event::Dock(Show::Open));
        log::info!("dock: opened over \"{}\" (in front: {})", win::window::title(game), in_front());
    });
}

/// Folds the open dock away. `give_back`: the window that was in front before gets the focus back (Resume, Circle,
/// a second hold); otherwise another window has already taken it.
pub fn fold(app: &AppHandle, give_back: bool) {
    let folded = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Shown::Open { game } = std::mem::replace(&mut *SHOWN.lock(), Shown::Folding) else { return };
        let showing = SHOWING.fetch_add(1, Ordering::SeqCst) + 1;
        events::emit(&folded, Event::Dock(Show::Closed));
        let Some(dock) = window::handle() else { return };
        // While it folds, the mouse already goes through to the game.
        win::dock::set_input(dock, win::dock::Input::Passive);
        if give_back {
            give_focus_back(&folded, HWND(game as *mut _));
        }
        hide_later(folded, showing, FOLD);
    });
}

/// Back to the window that was in front when the dock opened, or else to the game's own window.
fn give_focus_back(app: &AppHandle, game: HWND) {
    if win::window::is_visible(game) && !win::window::is_minimized(game) {
        win::window::force_foreground(game);
    } else {
        // Finding the game's window reads every process, which the main thread mustn't wait for.
        let app = app.clone();
        std::thread::spawn(move || launch::resume(&app));
    }
}

/// Hides the dock at once, when the home screen comes forward over it.
pub fn hide(app: &AppHandle) {
    if *SHOWN.lock() == Shown::Hidden {
        return;
    }
    let hidden = app.clone();
    let _ = app.run_on_main_thread(move || {
        if std::mem::replace(&mut *SHOWN.lock(), Shown::Hidden) == Shown::Hidden {
            return;
        }
        SHOWING.fetch_add(1, Ordering::SeqCst);
        if let Some(dock) = window::handle() {
            win::dock::hide(dock);
        }
        events::emit(&hidden, Event::Dock(Show::Closed));
    });
}

/// Hides the window after `after`, unless the dock was shown or folded again meanwhile.
fn hide_later(app: AppHandle, showing: u64, after: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(after);
        let hidden = app.clone();
        let _ = app.run_on_main_thread(move || {
            if SHOWING.load(Ordering::SeqCst) != showing {
                return;
            }
            *SHOWN.lock() = Shown::Hidden;
            let Some(dock) = window::handle() else { return };
            // Nothing took the foreground when the dock folded: the game closed when asked, say. A hidden window
            // mustn't keep it, so Lamplit comes forward, as it would a moment later for a game that ended.
            let stranded = win::window::foreground() == dock;
            win::dock::hide(dock);
            if stranded {
                log::info!("dock: no window to go back to; Lamplit comes forward");
                launch::window::bring_lamplit_forward(&hidden);
            }
        });
    });
}

/// Shows news in the folded dock for a moment, over a game the player is in. False when it can't show now: the
/// dock is off or open, no game runs, Lamplit is in front, or the game holds the screen in exclusive full screen.
fn show_news(app: &AppHandle, news: &News) -> bool {
    let showable = || {
        !is_open()
            && app.state::<Launcher>().running_id().is_some()
            && !launch::window::lamplit_in_front()
            && !win::dock::exclusive_full_screen()
    };
    if window::handle().is_none() || !showable() {
        return false;
    }
    let (shown, news) = (app.clone(), news.clone());
    let _ = app.run_on_main_thread(move || {
        let Some(dock) = window::handle() else { return };
        // The dock may have opened since.
        if is_open() {
            return;
        }
        window::place(dock, win::window::foreground(), window::Size::News);
        *SHOWN.lock() = Shown::News;
        let showing = SHOWING.fetch_add(1, Ordering::SeqCst) + 1;
        log::info!("dock: news \"{}\"", news.text);
        events::emit(&shown, Event::Dock(Show::Status(news)));
        hide_later(shown, showing, NEWS_FOR);
    });
    true
}

/// The dock's window lost the foreground: when another window has it now, the open dock folds away and leaves it
/// there. Asked a moment later, since focus moving into the dock's own page also reads as a loss.
fn lost_focus(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        if is_open() && !in_front() {
            log::info!("dock: another window took the foreground; folding");
            fold(&app, false);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::news::Icon;
    use super::*;

    #[test]
    fn holding_ps_picks_the_dock_only_over_a_game() {
        let over_a_game = Scene {
            dock_open: false,
            dock_on: true,
            game_runs: true,
            lamplit_in_front: false,
            exclusive_full_screen: false,
        };
        assert_eq!(choose(over_a_game), Summon::Dock);
        assert_eq!(choose(Scene { dock_open: true, ..over_a_game }), Summon::Fold);
        // The home screen as before: dock off, no game, Lamplit already in front, exclusive full screen.
        assert_eq!(choose(Scene { dock_on: false, ..over_a_game }), Summon::Home);
        assert_eq!(choose(Scene { game_runs: false, ..over_a_game }), Summon::Home);
        assert_eq!(choose(Scene { lamplit_in_front: true, ..over_a_game }), Summon::Home);
        assert_eq!(choose(Scene { exclusive_full_screen: true, ..over_a_game }), Summon::Home);
    }

    #[test]
    fn what_the_page_is_told_keeps_its_shape() {
        let news = News { icon: Icon::Controller, text: "DualSense battery low · 15%".into(), warn: true };
        let shows = [Show::Open, Show::Closed, Show::Status(news)];
        let shows: Vec<serde_json::Value> = shows.iter().map(|s| serde_json::to_value(s).unwrap()).collect();
        assert_eq!(serde_json::Value::Array(shows), ipc_fixture!("dock"));
        let icons = <Icon as strum::VariantArray>::VARIANTS;
        assert_eq!(serde_json::to_value(icons).unwrap(), ipc_fixture!("values")["dock_icon"]);
    }
}
