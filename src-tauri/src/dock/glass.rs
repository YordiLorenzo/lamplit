// Real glass under the dock's island (win/glass.rs), where Windows draws it: Windows 11 22H2 or later, with
// transparency effects on. The page asks for it once the island rests open and lets go of it before the island moves
// again; without it, the island keeps its glass made of the game's art.

use crate::win::glass::{Fold, Glass, Shape};
use crate::win::window::HWND;
use std::cell::RefCell;
use std::time::Duration;
use winreg::RegKey;
use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

/// Windows 11 22H2, the first Windows whose glass the dock uses.
const FIRST_BUILD: u32 = 22621;

/// Windows draws real glass: Windows 11 22H2 or later, with transparency effects on (Settings > Personalization >
/// Colors). With them off, its glass is a flat colour.
fn real_glass(build: u32, transparency: bool) -> bool {
    build >= FIRST_BUILD && transparency
}

fn build() -> u32 {
    let key = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    key.and_then(|k| k.get_value::<String, _>("CurrentBuildNumber")).ok().and_then(|b| b.parse().ok()).unwrap_or(0)
}

/// Windows' transparency effects, on unless the player switched them off.
fn transparency() -> bool {
    let key =
        RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    key.and_then(|k| k.get_value::<u32, _>("EnableTransparency")).map_or(true, |on| on != 0)
}

thread_local! {
    /// The glass, in the dock's window it was made for; an Err when Windows couldn't make it there. Made when first
    /// asked for, on the main thread, which owns the dock's window.
    static GLASS: RefCell<Option<(isize, windows::core::Result<Glass>)>> = const { RefCell::new(None) };
}

/// Real glass under the island where it rests, or with None none. True when the island rests on real glass now. On
/// the main thread.
pub fn show(island: Option<Shape>) -> bool {
    let Some(dock) = super::window::handle() else { return false };
    let shape = island.filter(|_| real_glass(build(), transparency()));
    GLASS.with_borrow_mut(|glass| {
        if shape.is_none() && glass.is_none() {
            return false;
        }
        let Some(glass) = made(glass, dock) else { return false };
        glass.show(shape).inspect_err(|e| log::warn!("dock: the glass didn't show: {e}")).is_ok() && shape.is_some()
    })
}

/// Makes the glass while the dock's window is hidden, where Windows draws it: the first opening then has nothing to
/// make. On the main thread.
pub fn prepare() {
    if let Some(dock) = super::window::handle()
        && real_glass(build(), transparency())
    {
        GLASS.with_borrow_mut(|glass| made(glass, dock).is_some());
    }
}

/// The glass in `dock`, made there first if it isn't yet; a new dock window (the dock was switched off and on) gets
/// glass of its own. None when Windows couldn't make it.
fn made(glass: &mut Option<(isize, windows::core::Result<Glass>)>, dock: HWND) -> Option<&Glass> {
    if glass.as_ref().is_none_or(|(made_for, _)| *made_for != dock.0 as isize) {
        let made = Glass::new(dock).inspect_err(|e| log::warn!("dock: no real glass, so the art's: {e}"));
        *glass = Some((dock.0 as isize, made));
    }
    glass.as_ref().and_then(|(_, made)| made.as_ref().ok())
}

/// Squeezes the glass into the pill with the island as the page folds it, if it shows. On the main thread.
pub fn fold(fold: &Fold) {
    GLASS.with_borrow(|glass| {
        if let Some((_, Ok(glass))) = glass
            && let Err(e) = glass.fold(fold)
        {
            log::warn!("dock: the glass didn't fold: {e}");
        }
    });
}

/// Fades the glass out with the island as it goes, if it shows: scaled to `scale` over `scale_for`, and out over
/// `fade_for`, `fade_after` in, as dock.css moves the island. On the main thread.
pub fn fade(scale: f32, scale_for: Duration, fade_for: Duration, fade_after: Duration) {
    GLASS.with_borrow(|glass| {
        if let Some((_, Ok(glass))) = glass
            && let Err(e) = glass.fade(scale, scale_for, fade_for, fade_after)
        {
            log::warn!("dock: the glass didn't fade: {e}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn real_glass_from_windows_11_22h2_with_transparency_on() {
        assert!(real_glass(22621, true));
        assert!(real_glass(26200, true));
        // Windows 11 21H2, and Windows 10.
        assert!(!real_glass(22000, true));
        assert!(!real_glass(19045, true));
        assert!(!real_glass(26200, false), "transparency effects off");
        assert!(!real_glass(0, true), "a build that couldn't be read");
    }
}
