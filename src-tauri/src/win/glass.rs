// Windows 11's glass under the dock's island: a visual of Windows.UI.Composition in the dock's own window, behind its
// page, filled with the host backdrop (what is behind the window, blurred by Windows, as for acrylic) and cut to the
// island's rounded shape. Acrylic for a whole window (DWMWA_SYSTEMBACKDROP_TYPE) fills the window's rectangle and
// ignores a window region (seen on Windows 11 25H2, 2026-10-27), so it can't take the island's shape.

use windows::System::{DispatcherQueue, DispatcherQueueController};
use windows::UI::Composition::Desktop::DesktopWindowTarget;
use windows::UI::Composition::{CompositionRoundedRectangleGeometry, Compositor, SpriteVisual};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DWMWA_USE_HOSTBACKDROPBRUSH, DwmSetWindowAttribute};
use windows::Win32::System::WinRT::Composition::ICompositorDesktopInterop;
use windows::Win32::System::WinRT::{
    CreateDispatcherQueueController, DQTAT_COM_NONE, DQTYPE_THREAD_CURRENT, DispatcherQueueOptions,
};
use windows::core::{BOOL, Interface};
use windows_numerics::{Vector2, Vector3};

/// Where the glass goes in its window, in pixels, and the radius of its corners: where the dock's island rests.
#[derive(Clone, Copy, PartialEq, Debug, serde::Deserialize)]
pub struct Shape {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub radius: f32,
}

pub struct Glass {
    /// The dispatcher queue this thread got for the compositor, if it had none.
    _queue: Option<DispatcherQueueController>,
    _target: DesktopWindowTarget,
    visual: SpriteVisual,
    shape: CompositionRoundedRectangleGeometry,
}

impl Glass {
    /// Puts the glass in `window`, hidden. Only on the thread that owns the window and handles its messages.
    pub fn new(window: HWND) -> windows::core::Result<Glass> {
        // A compositor needs a dispatcher queue on its thread.
        let queue = if DispatcherQueue::GetForCurrentThread().is_ok() {
            None
        } else {
            let options = DispatcherQueueOptions {
                dwSize: size_of::<DispatcherQueueOptions>() as u32,
                threadType: DQTYPE_THREAD_CURRENT,
                apartmentType: DQTAT_COM_NONE,
            };
            // SAFETY: takes the options by value and returns a new controller for this thread.
            Some(unsafe { CreateDispatcherQueueController(options) }?)
        };
        let on = BOOL(1);
        // SAFETY: passes a pointer to a local BOOL with its size; a stale handle makes the call fail.
        unsafe {
            DwmSetWindowAttribute(window, DWMWA_USE_HOSTBACKDROPBRUSH, (&raw const on).cast(), size_of::<BOOL>() as u32)
        }?;
        let compositor = Compositor::new()?;
        // Not topmost: the page's own window (WebView2's) draws over the glass.
        // SAFETY: the window belongs to this thread, as the call requires.
        let target =
            unsafe { compositor.cast::<ICompositorDesktopInterop>()?.CreateDesktopWindowTarget(window, false) }?;
        let visual = compositor.CreateSpriteVisual()?;
        visual.SetBrush(&compositor.CreateHostBackdropBrush()?)?;
        let shape = compositor.CreateRoundedRectangleGeometry()?;
        visual.SetClip(&compositor.CreateGeometricClipWithGeometry(&shape)?)?;
        visual.SetIsVisible(false)?;
        target.SetRoot(&visual)?;
        Ok(Glass { _queue: queue, _target: target, visual, shape })
    }

    /// Shows the glass with `shape`, or hides it.
    pub fn show(&self, shape: Option<Shape>) -> windows::core::Result<()> {
        let Some(s) = shape else { return self.visual.SetIsVisible(false) };
        let size = Vector2 { X: s.width, Y: s.height };
        self.visual.SetOffset(Vector3 { X: s.x, Y: s.y, Z: 0.0 })?;
        self.visual.SetSize(size)?;
        self.shape.SetSize(size)?;
        self.shape.SetCornerRadius(Vector2 { X: s.radius, Y: s.radius })?;
        self.visual.SetIsVisible(true)
    }
}
