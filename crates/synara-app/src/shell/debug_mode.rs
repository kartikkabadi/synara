//! Upstream parity: Debug is a persisted per-task interaction mode. It prepends
//! the provider-independent evidence-first instructions to provider-bound
//! prompts (`with_debug_prompt`); it grants no extra permissions and is not an
//! ACP session mode.
use super::controls::ControlKind;
use super::*;
use crate::ui;

impl Shell {
    pub(super) fn load_debug_mode(&mut self, task: TaskId, _cx: &mut Context<Self>) {
        let workspace = self.controller.workspace.clone();
        self.job(async move {
            let mode = workspace.interaction_mode(task).await?;
            Ok(Update::DebugMode {
                task,
                debug: mode == InteractionMode::Debug,
            })
        });
    }
    /// /debug, /default, the mode-menu row and the badge all land here.
    pub(super) fn set_debug_mode(
        &mut self,
        task: TaskId,
        debug: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        let mode = if debug {
            InteractionMode::Debug
        } else {
            InteractionMode::Default
        };
        let workspace = self.controller.workspace.clone();
        self.job(async move {
            workspace.set_interaction_mode(task, mode).await?;
            Ok(Update::DebugMode { task, debug })
        });
        cx.notify();
        true
    }
    /// Slash-command entry. The mode applies to the next provider turn, so it
    /// may change while a turn is in flight.
    pub(super) fn debug_mode_command(&mut self, debug: bool, cx: &mut Context<Self>) -> bool {
        let Some(task) = self.selected else {
            self.error = Some("Create or select a task first.".into());
            cx.notify();
            return false;
        };
        self.set_debug_mode(task, debug, cx)
    }
    /// Upstream /default also returns the provider session to its default mode
    /// where the session advertises one.
    pub(super) fn default_mode_command(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(task) = self.selected else {
            self.error = Some("Create or select a task first.".into());
            cx.notify();
            return false;
        };
        if self.debug_tasks.contains(&task) {
            self.set_debug_mode(task, false, cx);
        }
        if !self.controls_blocked()
            && let Some((choice, action)) = self
                .control_choices(ControlKind::Mode)
                .into_iter()
                .find(|(choice, _)| choice.label.eq_ignore_ascii_case("default"))
            && choice.unavailable.is_none()
            && !choice.selected
        {
            self.apply_session_control(task, action, cx);
        }
        true
    }
    pub(super) fn debug_mode_reply(&mut self, task: TaskId, debug: bool, cx: &mut Context<Self>) {
        if debug {
            self.debug_tasks.insert(task);
        } else {
            self.debug_tasks.remove(&task);
        }
        cx.notify();
    }
    /// Mode badge on the shared workflow strip; selecting it returns to
    /// Default, matching the upstream composer badge.
    pub(super) fn debug_compact(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let task = self.selected?;
        if !self.debug_tasks.contains(&task) {
            return None;
        }
        Some(
            ui::header_action(
                "debug-mode-off",
                "Debug",
                None,
                false,
                cx.listener(|this, _: &(), _, cx| {
                    if let Some(task) = this.selected {
                        this.set_debug_mode(task, false, cx);
                    }
                }),
            )
            .into_any_element(),
        )
    }
}
