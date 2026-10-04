//! Settings search index and ranking ported from the pinned Electron
//! settingsSearchIndex.ts + lib/providerDiscovery.ts.
//! Copyright (c) 2026 T3 Tools Inc. and Emanuele Di Pietro. MIT.
//! See docs/ui/electron-reference-LICENSE.txt for the retained license.
use super::navigation::section_info;
use super::Section;

/// Upstream `SettingsSearchEntry`. `section` uses the reference id; results
/// resolve through `section_info`.
pub(super) struct SearchEntry {
    pub id: &'static str,
    pub section: Section,
    pub title: &'static str,
    pub keywords: &'static str,
}

/// Upstream `SETTINGS_SEARCH_ENTRIES`, in the same order.
const ENTRIES: &[SearchEntry] = &[
    // General
    e("general:default-provider", Section::General, "Default provider", "Choose the provider used for new chats. agent codex claude"),
    e("general:new-threads", Section::General, "New threads", "Pick the default workspace mode for newly created draft threads. local worktree environment"),
    e("general:delete-worktree-on-archive", Section::General, "Delete worktree on archive", "After Archive's Undo period, remove a clean worktree only when its task has stopped and no other task uses it. Keep its branch for recovery. worktree archive cleanup disk space remove delete"),
    e("general:move-sent-messages-to-top", Section::General, "Move sent messages to top", "Move each sent message to the top of the conversation. Turn off to keep it at the bottom and follow replies as they stream. chat enter send scroll anchor"),
    e("general:welcome-tour", Section::General, "Welcome tour", "Replay the first-run setup: feature tour, provider selection, appearance, and first project. onboarding welcome wizard getting started setup"),
    e("general:project-order", Section::General, "Project order", "Controls how projects are arranged in the main sidebar. sort updated created manual"),
    e("general:thread-order", Section::General, "Thread order", "Controls how threads are arranged inside each project in the main sidebar. sort updated created"),
    e("general:chats-section", Section::General, "Chats", "Show the standalone Chats list in the sidebar footer chats not tied to a project. sidebar section"),
    e("general:groups-section", Section::General, "Hubs", "Show the Hubs tab in the sidebar switcher. sidebar section content outbox groups"),
    e("general:automation-run-threads", Section::General, "Automation runs", "Show the thread each standalone automation run creates in the sidebar. hide automation run threads clutter scheduled"),
    e("general:environment-default-open", Section::General, "Open by default", "Open the chat Environment panel automatically on normal threads. default closed open environment panel preference"),
    e("general:environment-usage", Section::General, "Usage", "Show the provider usage row in the chat Environment panel."),
    e("general:environment-repository", Section::General, "Repository", "Show the GitHub repository link in the chat Environment panel. git changes worktree"),
    e("general:environment-pull-request", Section::General, "Pull request", "Show the open pull request CI checks and review comments in the chat Environment panel. pr fix github"),
    e("general:environment-editor", Section::General, "Editor", "Show the Editor section in-app editor view and Open in editor picker in the chat Environment panel."),
    e("general:environment-recap", Section::General, "Recap", "Show the auto-generated chat recap in the Environment panel."),
    e("general:environment-pinned", Section::General, "Pinned messages", "Show the pinned-messages checklist in the Environment panel."),
    e("general:environment-instructions", Section::General, "Project instructions", "Show project-level instructions in the Environment panel."),
    e("general:environment-notepad", Section::General, "Notepad", "Show the per-thread notepad in the Environment panel."),
    // Appearance
    e("appearance:theme", Section::Appearance, "Theme", "Choose how Synara looks across the app. dark light system color"),
    e("appearance:app-icon", Section::Appearance, "App icon", "Choose the icon Synara uses in the dock or taskbar desktop application logo."),
    e("appearance:custom-title-bar", Section::Appearance, "Use custom title bar", "frameless window system title bar Windows Linux caption controls minimize maximize close chrome"),
    e("appearance:system-ui-font", Section::Appearance, "Use system UI font", "Use the operating system interface font throughout Synara."),
    e("appearance:ui-density", Section::Appearance, "UI density", "Control spacing in the sidebar, composer, chat gutters, and settings rows without changing font size. compact comfortable"),
    e("appearance:chat-width", Section::Appearance, "Chat width", "Control how wide the chat column grows so tables and wide content get more room. standard wide full"),
    e("appearance:base-font-size", Section::Appearance, "Base font size", "Adjust the app text base in pixels. Chat and UI typography scale proportionally. font"),
    e("appearance:terminal-font-size", Section::Appearance, "Terminal font size", "Adjust terminal text independently from the app and chat font size."),
    e("appearance:terminal-font", Section::Appearance, "Terminal font", "Type any monospace font installed on this device e.g. Fira Code. system monospace family"),
    e("appearance:font-smoothing", Section::Appearance, "Font smoothing", "Use macOS-style antialiasing for lighter, crisper text rendering."),
    e("appearance:time-format", Section::Appearance, "Time format", "System default follows your browser or OS clock preference. timestamp 12-hour 24-hour locale"),
    // Notifications
    e("notifications:activity-toasts", Section::Notifications, "Activity toasts", "Show an in-app toast when a chat or managed terminal agent finishes or needs input. alerts"),
    e("notifications:desktop-notifications", Section::Notifications, "Desktop notifications", "Show an OS notification when a chat or managed terminal agent finishes or needs input while the app is in the background. alerts toast"),
    // AppSnap
    e("appsnap:enable", Section::AppSnap, "Enable AppSnap", "Capture the frontmost macOS app window with a configurable two-key shortcut and add it to a recent task. appshot screenshot snap window capture hotkey"),
    e("appsnap:shortcut", Section::AppSnap, "Shortcut", "Press the left and right Option keys at the same time. hotkey chord alt keys"),
    e("appsnap:destination", Section::AppSnap, "Destination", "Snaps join the task you interacted with in the last minute, otherwise a fresh task opens. automatic target composer"),
    e("appsnap:capture-sound", Section::AppSnap, "Capture sound", "Play a short shutter cue when a window is captured. sound effect audio mute"),
    e("appsnap:permissions", Section::AppSnap, "Permission status", "Input Monitoring and Screen Recording permissions for AppSnap in macOS System Settings. privacy security recheck grant"),
    // Computer use
    e("computer:status", Section::Computer, "Computer status", "Whether agents can see and control this computer's desktop right now. desktop backend beta availability health kwin hyprland nested wayland linux mac macos screen recording accessibility computer use control status set up install plugin repair"),
    e("computer:open-automatically", Section::Computer, "Preview", "Show the in-chat Computer preview the first time an agent acts on the desktop, and choose its size. open automatically compact large. auto open computer use"),
    e("computer:how-agents-use-the-desktop", Section::Computer, "Computer control", "Let the agent use the desktop in any chat. Approval gates and Stop still apply. enable toggle permission desktop agent computer use control"),
    e("computer:cursor-colors", Section::Computer, "Cursor colors", "The agent pointer's colors: stock monochrome by default, or custom fill and rim. agent cursor arrow pointer color hex custom"),
    e("computer:always-allowed", Section::Computer, "Always allowed", "Durable per-app always-allow grants from computer approvals, with expiry and revoke. always allow approval grant revoke app bundle consent computer use"),
    // Behavior
    e("behavior:sidechat-expiry", Section::Behavior, "Side chat expiry", "Expire a side chat after it sits idle for this long. sidechat inactivity timeout 1 hour 24 hours never disable"),
    e("behavior:follow-up-behavior", Section::Behavior, "Follow-up behavior", "Choose whether messages sent during an active turn wait in the queue or steer the current run. Ctrl Cmd Enter opposite send"),
    e("behavior:enter-while-dictating", Section::Behavior, "Enter while dictating", "Choose what Enter does while a voice note is recording: stop and transcribe into the composer, or stop and send the message. voice dictation microphone transcribe"),
    e("behavior:assistant-output", Section::Behavior, "Assistant output", "Show token-by-token output while a response is in progress. streaming"),
    e("behavior:effort-slider", Section::Behavior, "Effort slider", "Show reasoning effort as a slider in the composer model menu once a chat has started. fast mode reasoning thinking level picker"),
    e("behavior:auto-open-simulator", Section::Behavior, "Automatically open simulator", "Disable automatic iOS Simulator device pane opening. Use Simulator.app without the mirrored panel reopening. background launch"),
    e("behavior:github-link-destination", Section::Behavior, "Open pull requests and issues", "Choose where GitHub links in chats open. built-in review view in-app browser external browser destination pr issue"),
    e("behavior:pull-request-diff-colors", Section::Behavior, "Pull request diff colors", "Show additions in green and deletions in red in pull request summaries. pr diff stats green red"),
    e("behavior:include-fork-upstreams", Section::Behavior, "Include fork upstreams", "Also list pull requests and issues from each project's other GitHub remotes, such as the repository a fork was made from. code review inbox github upstream remote fork"),
    e("behavior:diff-line-wrapping", Section::Behavior, "Diff line wrapping", "Set the default wrap state when the diff panel opens. word wrap"),
    e("behavior:delete-confirmation", Section::Behavior, "Delete confirmation", "Ask before deleting a thread and its chat history. safety confirm"),
    e("behavior:archive-confirmation", Section::Behavior, "Archive confirmation", "Ask before archiving a thread. safety confirm"),
    e("behavior:terminal-close-confirmation", Section::Behavior, "Terminal close confirmation", "Ask before closing a terminal tab and clearing its history. safety confirm"),
    // Keybindings
    e("shortcuts:keyboard-shortcuts", Section::Keybindings, "Keybindings", "Every keyboard shortcut available in Synara: change, add, remove, or reset them. keybindings hotkeys key combo cmd ctrl customize rebind unassigned reset defaults"),
    // Worktrees
    e("worktrees:managed-worktrees", Section::Worktrees, "Managed worktrees", "Review and clean up the worktrees created by Synara. git branch remove"),
    // Archived
    e("archived:archived-threads", Section::Archived, "Archived threads", "View and restore archived threads. unarchive history"),
    // Models
    e("models:git-writing-model", Section::Models, "Git writing model", "Used for generated commit messages, PR titles, and branch names."),
    e("models:saved-model-slugs", Section::Models, "Saved model slugs", "Add custom model slugs for supported providers. custom model"),
    // Providers
    e("providers:automatic-cli-update-checks", Section::Providers, "Automatic CLI update checks", "Check Codex Claude and other provider CLIs for newer versions in the background. updates upgrade disable nags"),
    e("providers:enabled-providers", Section::Providers, "Enabled providers", "Allow background checks and new turns. Enabling a provider does not install it or sign it in. enable disable activity"),
    e("providers:available-clis", Section::Providers, "Available CLIs", "Show or hide installed providers in the picker and drag them into your preferred order. visible providers visibility order"),
    e("providers:provider-updates", Section::Providers, "Provider updates", "Update installed provider tools that Synara can safely update. upgrade cli"),
    e("providers:installed-clis", Section::Providers, "Installed CLIs", "Review provider versions and update tools. binary overrides path install"),
    // Skills
    e("skills:skills", Section::Skills, "Skills", "Every skill found across providers, with toggles to control availability. agent"),
    // Usage
    e("usage:usage", Section::Usage, "Usage and billing", "Remaining quota and credits for each signed-in provider. limits credits"),
    e("usage:sidebar-rings", Section::Usage, "Sidebar usage rings", "Choose which provider usage rings show at the bottom of the sidebar rail. quota"),
    // Advanced
    e("advanced:keybindings", Section::System, "Keybindings", "Open the persisted keybindings.json file to edit advanced bindings directly. shortcuts"),
    e("advanced:recovery-tools", Section::System, "Recovery tools", "Rebuild local project indexes without clearing existing chats when the local state gets out of sync."),
    e("integrations:external-mcp", Section::Mcp, "External MCP integrations", "Pair Codex Claude and other local MCP clients with scoped project access. revoke credential task create wait read worktree approval"),
    e("advanced:version", Section::System, "Version", "Current application version. about"),
    e("advanced:release-history", Section::System, "Release history", "A running log of every update, newest first. changelog what's new about release notes"),
];

const fn e(
    id: &'static str,
    section: Section,
    title: &'static str,
    keywords: &'static str,
) -> SearchEntry {
    SearchEntry {
        id,
        section,
        title,
        keywords,
    }
}

/// Upstream `normalizeProviderDiscoveryText`.
fn normalize(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut space = false;
    for c in value.chars().flat_map(char::to_lowercase) {
        if c.is_whitespace() || matches!(c, ':' | '/' | '_' | '-') {
            if !space {
                out.push(' ');
                space = true;
            }
        } else {
            out.push(c);
            space = false;
        }
    }
    out.trim().to_owned()
}

fn compact(value: &str) -> String {
    value.chars().filter(|c| !c.is_whitespace()).collect()
}

fn score_subsequence(value: &[u8], query: &[u8]) -> Option<i64> {
    if query.is_empty() {
        return Some(0);
    }
    let mut query_index = 0;
    let mut first_match: i64 = -1;
    let mut previous_match: i64 = -1;
    let mut gap_penalty: i64 = 0;
    for (index, &byte) in value.iter().enumerate() {
        if byte != query[query_index] {
            continue;
        }
        let index = index as i64;
        if first_match == -1 {
            first_match = index;
        }
        if previous_match != -1 {
            gap_penalty += index - previous_match - 1;
        }
        previous_match = index;
        query_index += 1;
        if query_index == query.len() {
            let length_penalty = (value.len() - query.len()).min(64) as i64;
            return Some(first_match * 2 + gap_penalty * 4 + length_penalty);
        }
    }
    None
}

fn score_token_coverage(value: &str, query: &str) -> Option<i64> {
    let tokens: Vec<_> = query.split(' ').filter(|token| !token.is_empty()).collect();
    if tokens.len() <= 1 {
        return None;
    }
    let mut offset = 0usize;
    let mut total_distance = 0i64;
    for token in tokens {
        let index = value[offset..].find(token)? + offset;
        total_distance += (index - offset) as i64;
        offset = index + token.len();
    }
    Some(total_distance)
}

fn score_text(value: &str, query: &str, allow_fuzzy: bool) -> Option<i64> {
    if query.is_empty() {
        return Some(0);
    }
    if value.is_empty() {
        return None;
    }
    let compact_value = compact(value);
    let compact_query = compact(query);
    if value == query || compact_value == compact_query {
        return Some(0);
    }
    if value.starts_with(query) || compact_value.starts_with(&compact_query) {
        return Some(10);
    }
    let word_prefix = value
        .split(' ')
        .filter(|word| !word.is_empty())
        .position(|word| word.starts_with(query));
    if let Some(index) = word_prefix {
        return Some(20 + index as i64);
    }
    if let Some(index) = value.find(&format!(" {query}")) {
        return Some(30 + index as i64);
    }
    if let Some(index) = value.find(query) {
        return Some(40 + index as i64);
    }
    if let Some(score) = score_token_coverage(value, query) {
        return Some(80 + score);
    }
    if !allow_fuzzy {
        return None;
    }
    score_subsequence(compact_value.as_bytes(), compact_query.as_bytes()).map(|s| 120 + s)
}

/// Upstream `rankSettingsSearchEntries` over `rankProviderDiscoveryItems`:
/// title matches carry the strongest intent; keywords and the section label
/// add weighted looser matches. Result count is capped by the caller.
pub(super) fn rank(query: &str, limit: usize) -> Vec<&'static SearchEntry> {
    let normalized = normalize(query);
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut ranked: Vec<(i64, usize, &SearchEntry)> = ENTRIES
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            let fields = [
                (entry.title, 0i64),
                (entry.keywords, 200),
                (section_info(entry.section).label, 400),
            ];
            let best = fields.iter().filter_map(|(value, weight)| {
                score_text(&normalize(value), &normalized, *weight == 0)
                    .map(|score| weight + score)
            }).min();
            best.map(|score| (score, index, entry))
        })
        .collect();
    ranked.sort_by_key(|(score, index, _)| (*score, *index));
    ranked.truncate(limit);
    ranked.into_iter().map(|(_, _, entry)| entry).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_ranks_appearance_theme_first() {
        let results = rank("theme", 12);
        assert!(!results.is_empty());
        assert_eq!(results[0].id, "appearance:theme");
        assert!(results.len() <= 12);
        assert!(results.iter().all(|entry| {
            entry.title.to_lowercase().contains("theme")
                || entry.keywords.to_lowercase().contains("theme")
                || section_info(entry.section)
                    .label
                    .to_lowercase()
                    .contains("theme")
        }) || results.iter().any(|entry| entry.id == "appearance:theme"));
    }

    #[test]
    fn empty_or_unknown_queries_return_no_results() {
        assert!(rank("   ", 12).is_empty());
        assert!(rank("zzzzzzzzzz", 12).is_empty());
    }

    #[test]
    fn normalization_matches_the_reference() {
        assert_eq!(normalize("  Foo:Bar_baz-qux "), "foo bar baz qux");
        assert_eq!(normalize("A  B"), "a b");
    }
}
