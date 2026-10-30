// Windows 11's glass under the dock's island: a visual of Windows.UI.Composition in the dock's own window, behind its
// page, filled with the host backdrop (what is behind the window, blurred by Windows, as for acrylic) and cut to the
// island's rounded shape. Acrylic for a whole window (DWMWA_SYSTEMBACKDROP_TYPE) fills the window's rectangle and
// ignores a window region (seen on Windows 11 25H2, 2026-10-27), so it can't take the island's shape.

use std::time::Duration;
use windows::Foundation::TimeSpan;
use windows::System::{DispatcherQueue, DispatcherQueueController};
use windows::UI::Composition::Desktop::DesktopWindowTarget;
use windows::UI::Composition::{CompositionRoundedRectangleGeometry, Compositor, SpriteVisual};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DWMWA_USE_HOSTBACKDROPBRUSH, DwmSetWindowAttribute};
use windows::Win32::System::WinRT::Composition::ICompositorDesktopInterop;
use windows::Win32::System::WinRT::{
    CreateDispatcherQueueController, DQTAT_COM_NONE, DQTYPE_THREAD_CURRENT, DispatcherQueueOptions,
};
use windows::core::{BOOL, HSTRING, Interface};
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
        // As it was before a fade or a fold.
        for property in ["Opacity", "Scale", "Offset"] {
            self.visual.StopAnimation(&HSTRING::from(property))?;
        }
        for property in ["Offset", "Size", "CornerRadius"] {
            self.shape.StopAnimation(&HSTRING::from(property))?;
        }
        self.visual.SetOpacity(1.0)?;
        self.visual.SetScale(Vector3 { X: 1.0, Y: 1.0, Z: 1.0 })?;
        self.shape.SetOffset(Vector2 { X: 0.0, Y: 0.0 })?;
        let size = Vector2 { X: s.width, Y: s.height };
        self.visual.SetCenterPoint(Vector3 { X: s.width / 2.0, Y: s.height, Z: 0.0 })?;
        self.visual.SetOffset(Vector3 { X: s.x, Y: s.y, Z: 0.0 })?;
        self.visual.SetSize(size)?;
        self.shape.SetSize(size)?;
        self.shape.SetCornerRadius(Vector2 { X: s.radius, Y: s.radius })?;
        self.visual.SetIsVisible(true)
    }

    /// Fades the glass out as the island goes, on Windows' compositor: scaled to `scale` from its bottom centre over
    /// `scale_for` on CSS's `cubic-bezier(.2, .9, .25, 1)` (the page's glide), and out to nothing over `fade_for` on
    /// CSS's `ease`, `fade_after` in.
    pub fn fade(
        &self,
        scale: f32,
        scale_for: Duration,
        fade_for: Duration,
        fade_after: Duration,
    ) -> windows::core::Result<()> {
        let compositor = self.visual.Compositor()?;
        let glide =
            compositor.CreateCubicBezierEasingFunction(Vector2 { X: 0.2, Y: 0.9 }, Vector2 { X: 0.25, Y: 1.0 })?;
        let shrink = compositor.CreateVector3KeyFrameAnimation()?;
        shrink.InsertKeyFrameWithEasingFunction(1.0, Vector3 { X: scale, Y: scale, Z: 1.0 }, &glide)?;
        shrink.SetDuration(time(scale_for))?;
        self.visual.StartAnimation(&HSTRING::from("Scale"), &shrink)?;
        let ease =
            compositor.CreateCubicBezierEasingFunction(Vector2 { X: 0.25, Y: 0.1 }, Vector2 { X: 0.25, Y: 1.0 })?;
        let out = compositor.CreateScalarKeyFrameAnimation()?;
        out.InsertKeyFrameWithEasingFunction(1.0, 0.0, &ease)?;
        out.SetDuration(time(fade_for))?;
        out.SetDelayTime(time(fade_after))?;
        self.visual.StartAnimation(&HSTRING::from("Opacity"), &out)
    }
}

/// How the page folds the island, for the glass to fold the same way: its clip goes to `to` (in the window) over
/// `ms` along `curve` (the share of the way at even steps of time, as CSS `linear()` takes it), then it drops by
/// `drop` pixels and fades out over `fade` ms, `after` ms in.
#[derive(Clone, Debug, serde::Deserialize)]
pub struct Fold {
    pub to: Shape,
    pub ms: f32,
    pub curve: Vec<f32>,
    pub after: f32,
    pub fade: f32,
    pub drop: f32,
}

impl Glass {
    /// Squeezes the glass's clip into the pill as the page folds the island, on Windows' compositor.
    pub fn fold(&self, fold: &Fold) -> windows::core::Result<()> {
        let compositor = self.visual.Compositor()?;
        let linear = compositor.CreateLinearEasingFunction()?;
        let at = self.visual.Offset()?;
        let along = |property: &str, from: Vector2, to: Vector2| -> windows::core::Result<()> {
            let animation = compositor.CreateVector2KeyFrameAnimation()?;
            let last = fold.curve.len().saturating_sub(1).max(1) as f32;
            for (i, share) in fold.curve.iter().enumerate() {
                let value = Vector2 { X: from.X + (to.X - from.X) * share, Y: from.Y + (to.Y - from.Y) * share };
                animation.InsertKeyFrameWithEasingFunction(i as f32 / last, value, &linear)?;
            }
            animation.SetDuration(time(ms(fold.ms)))?;
            self.shape.StartAnimation(&HSTRING::from(property), &animation)
        };
        let to = &fold.to;
        along("Offset", self.shape.Offset()?, Vector2 { X: to.x - at.X, Y: to.y - at.Y })?;
        along("Size", self.shape.Size()?, Vector2 { X: to.width, Y: to.height })?;
        along("CornerRadius", self.shape.CornerRadius()?, Vector2 { X: to.radius, Y: to.radius })?;
        // Then the pill drops onto the edge and goes, as dock.css's glide and ease.
        let glide =
            compositor.CreateCubicBezierEasingFunction(Vector2 { X: 0.2, Y: 0.9 }, Vector2 { X: 0.25, Y: 1.0 })?;
        let down = compositor.CreateVector3KeyFrameAnimation()?;
        down.InsertKeyFrameWithEasingFunction(1.0, Vector3 { X: at.X, Y: at.Y + fold.drop, Z: at.Z }, &glide)?;
        down.SetDuration(time(ms(fold.fade)))?;
        down.SetDelayTime(time(ms(fold.after)))?;
        self.visual.StartAnimation(&HSTRING::from("Offset"), &down)?;
        let ease =
            compositor.CreateCubicBezierEasingFunction(Vector2 { X: 0.25, Y: 0.1 }, Vector2 { X: 0.25, Y: 1.0 })?;
        let out = compositor.CreateScalarKeyFrameAnimation()?;
        out.InsertKeyFrameWithEasingFunction(1.0, 0.0, &ease)?;
        out.SetDuration(time(ms(fold.fade)))?;
        out.SetDelayTime(time(ms(fold.after)))?;
        self.visual.StartAnimation(&HSTRING::from("Opacity"), &out)
    }
}

/// Milliseconds from the page, which counts in fractions of them.
fn ms(n: f32) -> Duration {
    Duration::from_secs_f32(n.max(0.0) / 1000.0)
}

/// A duration as Windows.Foundation counts it, in 100 ns.
fn time(d: Duration) -> TimeSpan {
    TimeSpan { Duration: i64::try_from(d.as_nanos() / 100).unwrap_or(i64::MAX) }
}
