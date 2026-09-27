//! Proposed-plan surface — upstream `ProposedPlanCard.tsx` (transcript card),
//! `ComposerPlanFollowUpBanner` (the "Plan ready" row above the composer), and
//! the follow-up submission resolution from `useChatTurnFollowUps`.
use super::*;
use crate::ui::{self, Glyph, palette};
use gpui::{ClickEvent, ClipboardItem, FontWeight};
use synara_core::{
    ProposedPlan, build_plan_implementation_prompt, build_plan_implementation_thread_title,
    build_proposed_plan_markdown_filename, collapsed_proposed_plan_preview,
    find_latest_proposed_plan, has_actionable_proposed_plan, normalize_plan_markdown_for_export,
    proposed_plan_title, strip_displayed_plan_markdown,
};

/// Upstream `truncateTitle`: trim, then cut at 50 chars and append "...".
fn truncate_title(text: String) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 50 {
        return trimmed.to_owned();
    }
    let mut truncated: String = trimmed.chars().take(50).collect();
    truncated.push_str("...");
    truncated
}

impl super::Shell {
    /// Upstream `findLatestProposedPlan` + `hasActionableProposedPlan` on the
    /// selected thread: the plan the composer banner and card act on.
    pub(super) fn actionable_proposed_plan(&self) -> Option<ProposedPlan> {
        let thread = self.thread.as_ref()?;
        let plan = find_latest_proposed_plan(
            &thread.proposed_plans,
            thread.turns.last().map(|turn| turn.id.as_str()),
        )?;
        has_actionable_proposed_plan(Some(plan)).then(|| plan.clone())
    }
    /// Upstream `showPlanFollowUpPrompt`: no pending inputs, plan mode, latest
    /// turn settled, and an actionable plan.
    pub(super) fn show_plan_follow_up(&self) -> bool {
        let Some(id) = self.selected else {
            return false;
        };
        let Some(thread) = self.thread.as_ref() else {
            return false;
        };
        self.mode_tasks
            .get(&id)
            .copied()
            .unwrap_or(InteractionMode::Default)
            == InteractionMode::Plan
            && !self.busy.contains(&id)
            && !self.connecting.contains(&id)
            && thread.inputs.is_empty()
            && self.actionable_proposed_plan().is_some()
    }
    /// Upstream composer placeholder chain entry:
    /// "Add feedback to refine the plan, or leave this blank to implement it".
    pub(super) fn sync_plan_composer(&mut self, cx: &mut Context<Self>) {
        let placeholder: &'static str = if self.show_plan_follow_up() {
            "Add feedback to refine the plan, or leave this blank to implement it"
        } else {
            "Ask for follow-up changes"
        };
        if self.composer.read(cx).placeholder() != placeholder {
            self.composer
                .update(cx, |entry, _| entry.set_placeholder(placeholder));
        }
    }
    /// Upstream `ComposerPlanFollowUpBanner`: "Plan ready" + plan title.
    pub(super) fn plan_follow_up_banner(&self) -> Option<gpui::AnyElement> {
        if !self.show_plan_follow_up() {
            return None;
        }
        let plan = self.actionable_proposed_plan()?;
        let title = proposed_plan_title(&plan.plan_markdown);
        Some(
            div()
                .px_5()
                .py_4()
                .flex()
                .flex_wrap()
                .items_center()
                .gap_2()
                .child(
                    div()
                        .text_size(px(ui::ui_font_size()))
                        .text_color(rgb(palette().muted))
                        .child("Plan ready"),
                )
                .children(title.map(|title| {
                    div()
                        .min_w_0()
                        .flex_1()
                        .overflow_hidden()
                        .text_size(px(ui::ui_font_size() + 1.))
                        .font_weight(FontWeight::MEDIUM)
                        .child(title)
                }))
                .into_any_element(),
        )
    }
    /// Upstream `ProposedPlanCard`: "Plan" badge + title + collapsible markdown
    /// + copy/download actions.
    pub(super) fn plan_row(&self, plan: &ProposedPlan, cx: &mut Context<Self>) -> gpui::AnyElement {
        let title =
            proposed_plan_title(&plan.plan_markdown).unwrap_or_else(|| "Proposed plan".into());
        let displayed = strip_displayed_plan_markdown(&plan.plan_markdown);
        let collapsible = displayed.len() > 900 || displayed.lines().count() > 20;
        let expanded = self.expanded_plans.contains(&plan.id);
        let body = if collapsible && !expanded {
            collapsed_proposed_plan_preview(&plan.plan_markdown, 10)
        } else {
            displayed
        };
        let plan_id = plan.id.clone();
        let copy_markdown = plan.plan_markdown.clone();
        let download_markdown = plan.plan_markdown.clone();
        let download_filename = build_proposed_plan_markdown_filename(&plan.plan_markdown);
        let download_root = self.task().map(|task| task.working_directory.clone());
        div()
            .rounded_md()
            .border_1()
            .border_color(rgb(palette().border))
            .bg(rgb(palette().canvas))
            .p_3()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .child(
                        // Upstream `Badge` — "Plan".
                        div()
                            .px_2()
                            .py_0p5()
                            .rounded_md()
                            .border_1()
                            .border_color(rgb(palette().border))
                            .text_size(px(ui::ui_font_size() - 1.))
                            .text_color(rgb(palette().muted))
                            .child("Plan"),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .font_weight(FontWeight::MEDIUM)
                            .text_size(px(ui::ui_font_size() + 1.))
                            .child(title),
                    )
                    // Upstream `ProposedPlanActions`: copy + download.
                    .child(
                        ui::chrome_button(
                            "copy-plan",
                            "Copy plan",
                            Glyph::Copy,
                            false,
                            cx.listener(move |this, _: &(), _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(
                                    copy_markdown.clone(),
                                ));
                                this.notice = Some("Plan copied as markdown".into());
                                cx.notify();
                            }),
                        )
                        .size(px(24.)),
                    )
                    .child(
                        ui::chrome_button(
                            "download-plan",
                            "Download plan",
                            Glyph::Attach,
                            download_root.is_none(),
                            cx.listener(move |this, _: &(), _, cx| {
                                let Some(root) = download_root.clone() else {
                                    return;
                                };
                                let path = root.join(&download_filename);
                                let text = normalize_plan_markdown_for_export(&download_markdown);
                                this.job(async move {
                                    std::fs::write(&path, text).map_err(|error| {
                                        synara_workspace::WorkspaceError::Invalid(error.to_string())
                                    })?;
                                    Ok(super::Update::Done(format!(
                                        "Plan saved to {}",
                                        path.display()
                                    )))
                                });
                                cx.notify();
                            }),
                        )
                        .size(px(24.)),
                    ),
            )
            .child(ui::markdown::render(&body, &plan.id))
            .when(collapsible, |card| {
                card.child(
                    ui::button(
                        SharedString::from(plan_id.clone()),
                        if expanded {
                            "Collapse plan"
                        } else {
                            "Expand plan"
                        },
                        false,
                    )
                    .on_click(cx.listener(
                        move |this, _: &ClickEvent, _, cx| {
                            if !this.expanded_plans.insert(plan_id.clone()) {
                                this.expanded_plans.remove(&plan_id);
                            }
                            if let Some(thread) = this.thread.as_ref() {
                                this.transcript.sync(thread, None, false);
                            }
                            cx.notify();
                        },
                    )),
                )
            })
            .into_any_element()
    }
    /// Upstream `ChatComposerFooter` while `showPlanFollowUp` holds: a typed
    /// draft submits "Refine"; an empty draft shows a split "Implement" button
    /// with a chevron menu carrying "Implement in a new thread".
    pub(super) fn plan_submit_buttons(
        &self,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> gpui::AnyElement {
        let has_prompt = !self.composer.read(cx).text().trim().is_empty();
        let button = |id: &'static str, label: &'static str, disabled: bool| {
            div()
                .id(id)
                .role(gpui::Role::Button)
                .aria_label(label)
                .tab_index(0)
                .h(px(32.))
                .px_4()
                .flex()
                .items_center()
                .text_size(px(ui::ui_font_size()))
                .when(disabled, |el| el.text_color(rgb(palette().muted)))
                .when(!disabled, |el| {
                    el.text_color(rgb(palette().canvas))
                        .cursor_pointer()
                        .hover(|style| style.bg(rgb(palette().focus)))
                })
        };
        if has_prompt {
            return button("composer-submit", "Refine", disabled)
                .rounded_md()
                .bg(rgb(if disabled {
                    palette().overlay
                } else {
                    palette().focus
                }))
                .when(!disabled, |el| {
                    el.on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                        this.send_prompt(cx);
                    }))
                })
                .child(ui::layout_probe_enabled("composer-submit", !disabled))
                .child("Refine")
                .into_any_element();
        }
        div()
            .flex()
            .items_center()
            .child(
                button("composer-submit", "Implement", disabled)
                    .rounded_l_md()
                    .bg(rgb(if disabled {
                        palette().overlay
                    } else {
                        palette().focus
                    }))
                    .when(!disabled, |el| {
                        el.on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                            this.send_prompt(cx);
                        }))
                    })
                    .child(ui::layout_probe_enabled("composer-submit", !disabled))
                    .child("Implement"),
            )
            .child(
                ui::icon_button(
                    "plan-implement-menu",
                    "Implementation actions",
                    Glyph::Chevron,
                    disabled,
                    cx.listener(|this, _: &(), window, cx| {
                        this.open_control(super::controls::ControlKind::PlanImplement, window, cx);
                    }),
                )
                .rounded_l_none()
                .border_l_1()
                .border_color(gpui::rgba(0xffffff1f)),
            )
            .into_any_element()
    }
    /// Upstream `onImplementPlanInNewThread` (useChatTurnFollowUps): create a
    /// same-project thread titled `Implement {plan title}`, dispatch the
    /// `PLEASE IMPLEMENT THIS PLAN:` prompt in default mode, and mark the
    /// source thread's plan implemented (upstream `sourceProposedPlan`). The
    /// new thread lands in the project directory — the port's one-task-per-
    /// linked-worktree rule keeps it from sharing the source worktree.
    pub(super) fn implement_plan_in_new_thread(&mut self, cx: &mut Context<Self>) {
        let Some(task) = self.task().cloned() else {
            return;
        };
        let Some(plan) = self.actionable_proposed_plan() else {
            return;
        };
        if self.busy.contains(&task.id)
            || self.connecting.contains(&task.id)
            || self.creating_task
            || self.loading_task.is_some()
        {
            return;
        }
        let title = truncate_title(build_plan_implementation_thread_title(&plan.plan_markdown));
        let prompt = build_plan_implementation_prompt(&plan.plan_markdown);
        let plan_id = plan.id.clone();
        let source_thread = task.thread_id;
        let project = task.project_id;
        let agent = task.agent_id.clone();
        let workspace = self.controller.workspace.clone();
        let controller = self.controller.clone();
        let revision = self.selection_revision;
        self.creating_task = true;
        self.job(async move {
            let result = async {
                let created = workspace
                    .create_scoped_task(project, title, agent, TaskScope::Project)
                    .await?;
                let submitted = async {
                    workspace
                        .record(
                            source_thread,
                            ThreadEvent::ProposedPlanImplemented {
                                plan_id,
                                implementation_thread_id: created.thread_id,
                            },
                        )
                        .await?;
                    controller.submit(created.id, prompt).await?;
                    Ok::<_, WorkspaceError>(())
                }
                .await;
                if let Err(error) = submitted {
                    // Upstream deletes the half-created thread when the
                    // implementation dispatch fails.
                    let _ = workspace.delete_task(created.id).await;
                    return Err(error);
                }
                let catalog = workspace.catalog().await?;
                Ok::<_, WorkspaceError>((created, catalog))
            }
            .await;
            Ok(match result {
                Ok((task, catalog)) => super::Update::TaskCreated(task, catalog, revision),
                Err(error) => super::Update::TaskCreationFailed(format!(
                    "Could not start implementation thread: {error}"
                )),
            })
        });
        cx.notify();
    }
}
