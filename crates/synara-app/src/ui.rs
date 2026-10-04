//! Native presentation primitives. Product state and operations stay in the controller.
mod icons;
pub mod markdown;
pub use icons::{Glyph, central_fill_icon, central_icon, icon, provider_glyph};
pub mod menu;
pub mod metrics;
pub mod motion;
mod personalization;
pub use personalization::{
    canvas_background, chat_width, code_font_size, glass_edge, motion_multiplier, row_height,
    settings_row_padding, shell_background, surface, terminal_font_size, ui_font_size,
};
pub mod task_dialog;
use gpui::{
    Context, Div, ElementId, SharedString, Stateful, Window, canvas, div, prelude::*, px, rgb, rgba,
};

pub const COMPOSER_INPUT_HEIGHT: f32 = 51.0;
pub const MENU_WIDTH: f32 = 304.0;
pub const MENU_ROW_HEIGHT: f32 = 42.0;
pub const MENU_MAX_HEIGHT: f32 = 294.0;
pub const SIDEBAR_WIDTH: f32 = 256.0;
/// Upstream `CHAT_SURFACE_HEADER_HEIGHT_PX` — the top strip / route header band.
pub const CHROME_HEIGHT: f32 = 44.0;
/// Upstream `MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX`: leading inset
/// past the macOS traffic-light cluster on the desktop top band.
pub const TRAFFIC_LIGHT_GUTTER: f32 = 90.0;
/// Upstream `--app-rail-inset-radius` (`--radius` 0.625rem * 1.3).
pub const INSET_RADIUS: f32 = 13.0;
/// Upstream `--app-rail-inset-gap`: the shell gap at the block's right/bottom.
pub const INSET_GAP: f32 = 3.0;
/// Upstream's system UI stack (`-apple-system`, `Segoe UI`, `system-ui`):
/// GPUI's `.SystemUIFont` resolves to the same per-platform family.
pub const UI_FONT: &str = ".SystemUIFont";

/// Semantic material roles, not per-screen RGB literals.
#[derive(Clone, Copy)]
pub struct Palette {
    pub canvas: u32,
    pub sidebar: u32,
    pub overlay: u32,
    pub hover: u32,
    pub selected: u32,
    pub border: u32,
    pub text: u32,
    pub muted: u32,
    pub focus: u32,
    pub error: u32,
    pub error_surface: u32,
    pub notice_surface: u32,
    /// Pending-approval row badge (upstream text-amber-300/90 dark,
    /// text-amber-600 light).
    pub pending: u32,
    /// Awaiting-input row dot (upstream indigo-300/90 dark,
    /// indigo-500 light).
    pub awaiting: u32,
    /// Whether this palette is a dark theme — project accent colors pick
    /// their dark variant from it (upstream `projectColorValue` uses the
    /// light/dark Tailwind pair).
    pub dark: bool,
}
/// Upstream default Codex dark theme (`theme.seed.generated.ts` codex.dark:
/// surface #111111, ink #fcfcfc, accent #0169cc) composed over the surface
/// with `buildDarkDerivedTokens` (contrast 0): secondary fills are 4–9% ink
/// tints, the border is 10% ink, secondary text 65% ink, the focus ring the
/// accent mixed 30% toward white.
pub const DARK: Palette = Palette {
    canvas: 0x111111,
    sidebar: 0x151515,
    overlay: 0x1e1e1e,
    hover: 0x1f1f1f,
    selected: 0x262626,
    border: 0x292929,
    text: 0xfcfcfc,
    muted: 0xa9a9a9,
    focus: 0x4d96db,
    error: 0xffb9c0,
    error_surface: 0x432c35,
    notice_surface: 0x303a4a,
    pending: 0xe7c24a,
    awaiting: 0x98a6e8,
    dark: true,
};

/// Upstream default Codex light theme (codex.light: surface #ffffff,
/// ink #0d0d0d, accent #0169cc) with `buildLightDerivedTokens`.
pub const LIGHT: Palette = Palette {
    canvas: 0xffffff,
    sidebar: 0xffffff,
    overlay: 0xffffff,
    hover: 0xf7f7f7,
    selected: 0xf2f2f2,
    border: 0xe9e9e9,
    text: 0x0d0d0d,
    muted: 0x626262,
    focus: 0x0169cc,
    error: 0x99283b,
    error_surface: 0xffe4e8,
    notice_surface: 0xe6edf7,
    pending: 0xd97706,
    awaiting: 0x6366f1,
    dark: false,
};
// Synara currently owns one application window. All native views, including
// menus and text entries, paint on the UI thread and share its current palette.
thread_local! {
    static PALETTE: std::cell::Cell<Palette> = const { std::cell::Cell::new(DARK) };
    static UI_FAMILY: std::cell::RefCell<SharedString> = std::cell::RefCell::new(UI_FONT.into());
    static CODE_FAMILY: std::cell::RefCell<SharedString> = std::cell::RefCell::new("DejaVu Sans Mono".into());
}
pub fn palette() -> Palette {
    PALETTE.with(std::cell::Cell::get)
}
/// Upstream `--app-rail-shell-tone`: the band+rail tone behind the inset
/// block — surface mixed toward white in dark themes, black in light.
pub fn shell_tone() -> u32 {
    let palette = palette();
    let anchor = if palette.dark { 0xffffff } else { 0x000000 };
    mix_rgb(palette.canvas, anchor, if palette.dark { 0.05 } else { 0.03 })
}
/// Upstream `--app-rail-inset-border`: the block/tab hairline — 9% ink in
/// dark themes, 10% in light.
pub fn inset_border() -> gpui::Rgba {
    rgba((palette().text << 8) | if palette().dark { 0x17 } else { 0x1a })
}
fn mix_rgb(a: u32, b: u32, amount: f32) -> u32 {
    let channel = |shift| {
        let a = ((a >> shift) & 0xff_u32) as f32;
        let b = ((b >> shift) & 0xff_u32) as f32;
        (a + (b - a) * amount).round() as u32
    };
    (channel(16) << 16) | (channel(8) << 8) | channel(0)
}
pub fn ui_font() -> SharedString {
    UI_FAMILY.with(|family| family.borrow().clone())
}
pub fn code_font() -> SharedString {
    CODE_FAMILY.with(|family| family.borrow().clone())
}
pub fn configure(
    appearance: &synara_workspace::AppearanceSettings,
    system: gpui::WindowAppearance,
) {
    use synara_workspace::{DarkThemePreference, ThemePreference};
    let dark = match appearance.theme {
        ThemePreference::System => matches!(
            system,
            gpui::WindowAppearance::Dark | gpui::WindowAppearance::VibrantDark
        ),
        ThemePreference::Light => false,
        ThemePreference::Dark => true,
    };
    let palette = if !dark {
        LIGHT
    } else if appearance.dark_theme == DarkThemePreference::Dracula {
        Palette {
            canvas: 0x282a36,
            sidebar: 0x252731,
            overlay: 0x30323f,
            hover: 0x30323c,
            selected: 0x393b49,
            border: 0x393b46,
            text: 0xf8f8f2,
            muted: 0xa4a3ae,
            focus: 0xff79c6,
            ..DARK
        }
    } else {
        DARK
    };
    let mut palette = personalization::colorway(palette, appearance.personalization.colorway, dark);
    palette.dark = dark;
    if let Some(accent) = appearance.personalization.accent {
        palette.focus = personalization::readable_accent(accent, palette.canvas);
    }
    if appearance.high_contrast {
        palette.muted = palette.text;
        palette.border = if dark { 0x9a9aa4 } else { 0x64646e };
    }
    PALETTE.set(palette);
    personalization::configure(appearance);
    UI_FAMILY.with(|family| {
        *family.borrow_mut() = appearance
            .fonts
            .ui_family
            .clone()
            .map(SharedString::from)
            .unwrap_or_else(|| UI_FONT.into())
    });
    CODE_FAMILY.with(|family| {
        *family.borrow_mut() = appearance
            .fonts
            .code_family
            .clone()
            .map(SharedString::from)
            .unwrap_or_else(|| "DejaVu Sans Mono".into())
    });
}

/// GPUI maps unmodified Enter/Space press-release and accessibility clicks to
/// on_click. Do not add a second keydown/accessibility callback: that bypasses
/// release/blur cancellation and can dispatch a backend operation twice.
pub fn button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    selected: bool,
) -> Stateful<Div> {
    let label = label.into();
    button_shell(id, label.clone(), selected).child(label)
}

pub fn button_shell(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    selected: bool,
) -> Stateful<Div> {
    let label = label.into();
    div()
        .id(id)
        .role(gpui::Role::Button)
        .aria_label(label.clone())
        .tab_index(0)
        .px_3()
        .py_1()
        .rounded_md()
        .border_1()
        .border_color(rgba(0x00000000))
        .bg(rgb(if selected {
            palette().selected
        } else {
            palette().overlay
        }))
        .text_color(rgb(palette().text))
        .text_size(px(ui_font_size()))
        .cursor_pointer()
        .hover(|style| style.bg(rgb(palette().hover)))
        .active(|style| style.bg(rgb(palette().selected)))
        .focus_visible(|style| style.border_color(rgb(palette().focus)))
}

/// Mouse, native keyboard activation and assistive activation use one callback.
pub fn action(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    glyph: Option<Glyph>,
    selected: bool,
    activate: impl Fn(&(), &mut Window, &mut gpui::App) + 'static,
) -> Stateful<Div> {
    let label = label.into();
    div()
        .id(id)
        .role(gpui::Role::Button)
        .aria_label(label.clone())
        .tab_index(0)
        .h(px(row_height()))
        .min_w_0()
        .px_2()
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded_md()
        .border_1()
        .border_color(rgba(0x00000000))
        .bg(rgba(if selected {
            (palette().selected << 8) | 0xff
        } else {
            0
        }))
        .text_color(rgb(palette().text))
        .text_size(px(ui_font_size()))
        .cursor_pointer()
        .hover(|style| style.bg(rgb(palette().hover)))
        .active(|style| style.bg(rgb(palette().selected)))
        .focus_visible(|style| style.border_color(rgb(palette().focus)))
        .on_click(move |_, window, cx| {
            activate(&(), window, cx);
            cx.stop_propagation();
        })
        .children(glyph.map(icon))
        .child(div().flex_1().min_w_0().text_ellipsis().child(label))
}

/// Chat-header control matching Electron's `ChatHeaderButton` (outline tone):
/// fixed 28px height, 8px radius, visible outline border, full-strength glyph.
pub fn header_action(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    glyph: Option<Glyph>,
    selected: bool,
    activate: impl Fn(&(), &mut Window, &mut gpui::App) + 'static,
) -> Stateful<Div> {
    let label = label.into();
    div()
        .id(id)
        .role(gpui::Role::Button)
        .aria_label(label.clone())
        .tab_index(0)
        .h(px(28.))
        .min_w_0()
        .px_2()
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded(px(8.))
        .border_1()
        .border_color(rgb(palette().border))
        .bg(rgba(if selected {
            (palette().selected << 8) | 0xff
        } else {
            0
        }))
        .text_color(rgb(palette().text))
        .text_size(px(ui_font_size()))
        .cursor_pointer()
        .hover(|style| style.bg(rgb(palette().hover)))
        .active(|style| style.bg(rgb(palette().selected)))
        .focus_visible(|style| style.border_color(rgb(palette().focus)))
        .on_click(move |_, window, cx| {
            activate(&(), window, cx);
            cx.stop_propagation();
        })
        .children(glyph.map(icon))
        .child(div().flex_1().min_w_0().text_ellipsis().child(label))
}

/// `action` with a caller-provided leading element — project rows render a
/// favicon or appearance glyph instead of a `Glyph`.
pub fn action_icon(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    icon: Option<gpui::AnyElement>,
    selected: bool,
    activate: impl Fn(&(), &mut Window, &mut gpui::App) + 'static,
) -> Stateful<Div> {
    let label = label.into();
    div()
        .id(id)
        .role(gpui::Role::Button)
        .aria_label(label.clone())
        .tab_index(0)
        .h(px(row_height()))
        .min_w_0()
        .px_2()
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded_md()
        .border_1()
        .border_color(rgba(0x00000000))
        .bg(rgba(if selected {
            (palette().selected << 8) | 0xff
        } else {
            0
        }))
        .text_color(rgb(palette().text))
        .text_size(px(ui_font_size()))
        .cursor_pointer()
        .hover(|style| style.bg(rgb(palette().hover)))
        .active(|style| style.bg(rgb(palette().selected)))
        .focus_visible(|style| style.border_color(rgb(palette().focus)))
        .on_click(move |_, window, cx| {
            activate(&(), window, cx);
            cx.stop_propagation();
        })
        .children(icon)
        .child(div().flex_1().min_w_0().text_ellipsis().child(label))
}

pub(crate) struct Tooltip(pub(crate) SharedString);

/// Preserve the navigation landmark while accurately exposing unavailable capabilities.
pub fn unavailable_action(
    id: &'static str,
    label: &'static str,
    glyph: Glyph,
    reason: &'static str,
) -> Stateful<Div> {
    div()
        .id(id)
        .role(gpui::Role::Label)
        .aria_label(format!("{label}, unavailable"))
        .aria_description(reason)
        .tab_index(0)
        .h(px(row_height()))
        .px_2()
        .flex()
        .items_center()
        .gap(px(6.))
        .text_size(px(15.))
        .text_color(rgb(palette().text))
        .opacity(0.78)
        .rounded_md()
        .border_1()
        .border_color(rgba(0))
        .focus_visible(|style| style.border_color(rgb(palette().focus)))
        .cursor_default()
        .tooltip(move |_, cx| cx.new(|_| Tooltip(reason.into())).into())
        .child(icon(glyph))
        .child(label)
}
impl Render for Tooltip {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .max_w(px(400.0))
            .px_2()
            .py_1()
            .rounded_md()
            .border_1()
            .border_color(rgb(palette().border))
            .bg(rgb(palette().overlay))
            .font_family(ui_font())
            .text_size(px(12.0))
            .text_color(rgb(palette().text))
            .child(self.0.clone())
    }
}

/// A named compact action, with native press/release behavior and guarded disablement.
pub fn icon_button(
    id: &'static str,
    label: &'static str,
    glyph: Glyph,
    disabled: bool,
    activate: impl Fn(&(), &mut Window, &mut gpui::App) + 'static,
) -> Stateful<Div> {
    div()
        .id(id)
        .role(gpui::Role::Button)
        .aria_label(label)
        .when(disabled, |el| el.aria_description("Currently unavailable"))
        .tab_index(0)
        .size(px(30.))
        .flex_shrink_0()
        .flex()
        .items_center()
        .justify_center()
        .rounded_full()
        .border_1()
        .border_color(rgba(0))
        .bg(rgb(palette().selected))
        .cursor_pointer()
        .hover(|style| style.bg(rgb(palette().hover)))
        .focus_visible(|style| style.border_color(rgb(palette().focus)))
        .when(disabled, |el| el.opacity(0.4).cursor_default())
        .tooltip(move |_, cx| cx.new(|_| Tooltip(label.into())).into())
        .on_click(move |_, window, cx| {
            if !disabled {
                activate(&(), window, cx);
            }
        })
        .relative()
        .child(icon(glyph))
}

/// Opt-in geometry diagnostics only. Never logs labels, paths, prompts or request IDs.
pub fn layout_probe(id: &'static str) -> impl IntoElement {
    canvas(move |bounds, _, _| {
        tracing::debug!(target: "synara_ui_layout", control = id,
            x = f32::from(bounds.origin.x), y = f32::from(bounds.origin.y),
            width = f32::from(bounds.size.width), height = f32::from(bounds.size.height), "control-layout");
    }, |_, _, _, _| {}).absolute().top_0().left_0().size_full()
}

/// The same opt-in geometry, with the actual interaction-ready state.
pub fn layout_probe_enabled(id: &'static str, enabled: bool) -> impl IntoElement {
    canvas(move |bounds, _, _| {
        tracing::debug!(target: "synara_ui_layout", control = id, enabled,
            x = f32::from(bounds.origin.x), y = f32::from(bounds.origin.y),
            width = f32::from(bounds.size.width), height = f32::from(bounds.size.height), "control-layout");
    }, |_, _, _, _| {}).absolute().top_0().left_0().size_full()
}

pub fn layout_probe_slot(id: &'static str, slot: usize) -> impl IntoElement {
    canvas(move |bounds, _, _| {
        tracing::debug!(target: "synara_ui_layout", control = id, slot,
            x = f32::from(bounds.origin.x), y = f32::from(bounds.origin.y),
            width = f32::from(bounds.size.width), height = f32::from(bounds.size.height), "control-layout");
    }, |_, _, _, _| {}).absolute().top_0().left_0().size_full()
}

/// Upstream button-secondary ink fills (a fraction of the text color):
/// resting 4%, hover 6%, pressed 9% (`buildDarkDerivedTokens`, contrast 0).
pub fn secondary_fill() -> Rgba {
    rgba((palette().text << 8) | 0x0a)
}
pub fn hover_fill() -> Rgba {
    rgba((palette().text << 8) | 0x0f)
}
pub fn active_fill() -> Rgba {
    rgba((palette().text << 8) | 0x17)
}

/// Quiet chrome action matching upstream's `CHAT_HEADER_ICON_CONTROL` —
/// 28px, 8px radius, transparent until hovered; its accessible name remains
/// available without a text label.
pub fn chrome_button(
    id: &'static str,
    label: &'static str,
    glyph: Glyph,
    disabled: bool,
    activate: impl Fn(&(), &mut Window, &mut gpui::App) + 'static,
) -> Stateful<Div> {
    icon_button(id, label, glyph, disabled, activate)
        .size(px(28.))
        .rounded(px(8.))
        .bg(rgba(0))
        .hover(|style| style.bg(hover_fill()))
        .child(layout_probe(id))
}

pub struct Assets;
impl gpui::AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<std::borrow::Cow<'static, [u8]>>> {
        Ok(match path {
            "brand/synara.svg" => Some(std::borrow::Cow::Borrowed(include_bytes!(
                "../assets/synara.svg"
            ))),
            _ => icons::load(path),
        })
    }

    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(if "brand/synara.svg".starts_with(path) {
            vec!["brand/synara.svg".into()]
        } else {
            vec![]
        })
    }
}
