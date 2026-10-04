//! Settings taxonomy adapted from the pinned Electron settingsNavigation.ts.
//! Copyright (c) 2026 T3 Tools Inc. and Emanuele Di Pietro. MIT.
//! See docs/ui/electron-reference-LICENSE.txt for the retained license.
use super::{Glyph, Section, SectionInfo};

const fn item(
    section: Section,
    id: &'static str,
    group: &'static str,
    label: &'static str,
    icon: Glyph,
    description: &'static str,
    badge: Option<&'static str>,
) -> SectionInfo {
    SectionInfo {
        section,
        id,
        group,
        label,
        icon,
        description,
        badge,
    }
}

/// Upstream `SETTINGS_NAV_GROUPS` order.
pub(super) const GROUPS: &[&str] =
    &["Personal", "Integrations", "Coding", "System", "Archived"];

/// Upstream `SETTINGS_NAV_ITEMS`: ids and copy match the reference exactly.
pub(super) const SECTIONS: &[SectionInfo] = &[
    item(
        Section::General,
        "general",
        "Personal",
        "General",
        Glyph::Settings,
        "Choose defaults for new chats, navigation, and the Environment panel.",
        None,
    ),
    item(
        Section::Profile,
        "profile",
        "Personal",
        "Profile",
        Glyph::User,
        "Your local activity, streaks, and a shareable stats card.",
        None,
    ),
    item(
        Section::Appearance,
        "appearance",
        "Personal",
        "Appearance",
        Glyph::Palette,
        "Customize the theme, typography, density, and time format.",
        None,
    ),
    item(
        Section::Notifications,
        "notifications",
        "Personal",
        "Notifications",
        Glyph::Bell,
        "Choose how Synara tells you when work finishes or needs attention.",
        None,
    ),
    item(
        Section::Behavior,
        "behavior",
        "Personal",
        "Chat behavior",
        Glyph::Sliders,
        "Control live responses, follow-ups, review defaults, and safety confirmations.",
        None,
    ),
    item(
        Section::Keybindings,
        "shortcuts",
        "Personal",
        "Keybindings",
        Glyph::Shortcut,
        "Change, add, or remove the shortcut for every Synara command.",
        None,
    ),
    item(
        Section::Usage,
        "usage",
        "Personal",
        "Usage & limits",
        Glyph::Gauge,
        "See remaining quota and credits for every signed-in provider.",
        None,
    ),
    item(
        Section::AppSnap,
        "appsnap",
        "Integrations",
        "AppSnap",
        Glyph::Capture,
        "Capture another app's frontmost window directly into a task.",
        None,
    ),
    item(
        Section::Computer,
        "computer",
        "Integrations",
        "Computer use",
        Glyph::Window,
        "Let agents see and control this computer's desktop, and check backend status.",
        Some("Beta"),
    ),
    item(
        Section::Mcp,
        "integrations",
        "Integrations",
        "MCP connections",
        Glyph::Plugin,
        "Give Codex, Claude, and other local agents scoped access to Synara tasks.",
        None,
    ),
    item(
        Section::Providers,
        "providers",
        "Coding",
        "Agent providers",
        Glyph::Puzzle,
        "Choose visible coding agents and manage their installed CLI tools.",
        None,
    ),
    item(
        Section::Models,
        "models",
        "Coding",
        "Models & writing",
        Glyph::Brain,
        "Choose the model used for Git writing and add custom model slugs.",
        None,
    ),
    item(
        Section::Skills,
        "skills",
        "Coding",
        "Agent skills",
        Glyph::Blocks,
        "Review reusable workflows discovered across all configured providers.",
        None,
    ),
    item(
        Section::Worktrees,
        "worktrees",
        "Coding",
        "Managed worktrees",
        Glyph::BranchSimple,
        "Review and clean up isolated workspaces created by Synara.",
        None,
    ),
    item(
        Section::System,
        "advanced",
        "System",
        "System tools",
        Glyph::Toolbox,
        "Manage sessions, recovery tools, low-level keybindings, and version details.",
        None,
    ),
    item(
        Section::Archived,
        "archived",
        "Archived",
        "Archived threads",
        Glyph::Archive,
        "Find and restore threads you previously archived.",
        None,
    ),
];

/// The onboarding flow still drives `Section::Onboarding`; it is not a settings
/// nav entry upstream, so it carries its own panel copy instead of a SECTIONS
/// row.
pub(super) const ONBOARDING: SectionInfo = SectionInfo {
    section: Section::Onboarding,
    id: "onboarding",
    group: "",
    label: "Getting started",
    icon: Glyph::Help,
    description: "Replay the welcome tour, check local agent commands, and set up your workspace.",
    badge: None,
};

pub(super) fn section_info(section: Section) -> &'static SectionInfo {
    SECTIONS
        .iter()
        .find(|item| item.section == section)
        .unwrap_or(&ONBOARDING)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn navigation_matches_the_reference_taxonomy() {
        let actual: Vec<_> = SECTIONS
            .iter()
            .map(|item| (item.id, item.group, item.label))
            .collect();
        assert_eq!(
            actual,
            vec![
                ("general", "Personal", "General"),
                ("profile", "Personal", "Profile"),
                ("appearance", "Personal", "Appearance"),
                ("notifications", "Personal", "Notifications"),
                ("behavior", "Personal", "Chat behavior"),
                ("shortcuts", "Personal", "Keybindings"),
                ("usage", "Personal", "Usage & limits"),
                ("appsnap", "Integrations", "AppSnap"),
                ("computer", "Integrations", "Computer use"),
                ("integrations", "Integrations", "MCP connections"),
                ("providers", "Coding", "Agent providers"),
                ("models", "Coding", "Models & writing"),
                ("skills", "Coding", "Agent skills"),
                ("worktrees", "Coding", "Managed worktrees"),
                ("advanced", "System", "System tools"),
                ("archived", "Archived", "Archived threads"),
            ]
        );
    }

    #[test]
    fn ids_are_unique_and_computer_carries_the_beta_badge() {
        let ids: HashSet<_> = SECTIONS.iter().map(|item| item.id).collect();
        assert_eq!(ids.len(), SECTIONS.len());
        assert_eq!(SECTIONS.len(), 16);
        assert_eq!(
            SECTIONS
                .iter()
                .find(|item| item.badge.is_some())
                .map(|item| (item.id, item.badge)),
            Some(("computer", Some("Beta")))
        );
    }
}
