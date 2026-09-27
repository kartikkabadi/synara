//! Proposed-plan surface — upstream `ProposedPlanCard.tsx` (transcript card),
//! `ComposerPlanFollowUpBanner` (the "Plan ready" row above the composer), and
//! the follow-up submission resolution from `useChatTurnFollowUps`.
use super::*;
use crate::ui::{self, Glyph, palette};
use gpui::{ClickEvent, ClipboardItem, FontWeight};
use synara_core::{
    ProposedPlan, build_plan_implementation_prompt, build_plan_implementation_thread_title,
    build_proposed_plan_markdown_filename, collapsed_proposed_plan_preview,
    find_latest_proposed_plan, find_sidebar_proposed_plan, has_actionable_proposed_plan,
    normalize_plan_markdown_for_export, proposed_plan_title, strip_displayed_plan_markdown,
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
    /// Upstream `findSidebarProposedPlan`: while the implementation turn is
    /// unsettled, resolve the plan through `source_proposed_plan` against the
    /// fetched source thread; otherwise this thread's latest unimplemented plan.
    pub(super) fn sidebar_proposed_plan(&self) -> Option<ProposedPlan> {
        let thread = self.thread.as_ref()?;
        find_sidebar_proposed_plan(
            &thread.proposed_plans,
            self.sidebar_source_plan.as_slice(),
            thread.turns.last(),
        )
        .cloned()
    }
    /// The port holds only the active thread, so the source thread's plan is
    /// loaded lazily (upstream resolves it synchronously from `threads[]`).
    pub(super) fn maybe_load_sidebar_source(&mut self, cx: &mut Context<Self>) {
        let source = self
            .thread
            .as_ref()
            .and_then(|thread| thread.turns.last())
            .filter(|turn| turn.finished_at_ms.is_none() && !turn.failed)
            .and_then(|turn| turn.source_proposed_plan.clone());
        let Some(source) = source else {
            return;
        };
        if self
            .sidebar_source_plan
            .as_ref()
            .is_some_and(|plan| plan.id == source.plan_id)
            || self.sidebar_source_loading.as_deref() == Some(source.plan_id.as_str())
        {
            return;
        }
        self.sidebar_source_loading = Some(source.plan_id.clone());
        let workspace = self.controller.workspace.clone();
        self.job(async move {
            let plan = workspace
                .thread(source.thread_id)
                .await
                .ok()
                .and_then(|thread| {
                    thread
                        .proposed_plans
                        .into_iter()
                        .find(|plan| plan.id == source.plan_id)
                });
            Ok(super::Update::SidebarSourcePlan(
                source.plan_id.clone(),
                plan,
            ))
        });
        cx.notify();
    }
    /// Upstream `setPlanSidebarOpen(!planSidebarOpen)`.
    pub(super) fn toggle_plan_sidebar(&mut self, cx: &mut Context<Self>) {
        self.plan_sidebar_open = !self.plan_sidebar_open;
        cx.notify();
    }
    /// Upstream `ChatComposerFooter`'s `sidebarAction`: a ghost button with the
    /// sidebar icon + "Plan details"/"Tasks" label, rendered when a sidebar
    /// plan exists or the sidebar is open; toggles to "Hide …" while open.
    pub(super) fn plan_sidebar_toggle(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let has_plan = self.sidebar_proposed_plan().is_some();
        if !has_plan && !self.plan_sidebar_open {
            return None;
        }
        let base = if has_plan { "Plan details" } else { "Tasks" };
        let label = if self.plan_sidebar_open {
            format!("Hide {base}")
        } else {
            base.to_owned()
        };
        let title: SharedString = format!(
            "{} {} sidebar",
            if self.plan_sidebar_open {
                "Hide"
            } else {
                "Show"
            },
            base.to_lowercase()
        )
        .into();
        Some(
            ui::button_shell("plan-sidebar-toggle", title.clone(), false)
                .flex()
                .items_center()
                .gap(px(6.))
                .text_size(px(14.))
                .px_2()
                .py_1()
                .bg(gpui::rgba(0))
                .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                    this.toggle_plan_sidebar(cx);
                }))
                .child(ui::icon(Glyph::PanelRight))
                .child(label)
                .into_any_element(),
        )
    }
    /// Upstream `PlanSidebar.tsx`: a `w-[340px]` right-side panel with a
    /// "Plan" badge header (copy/download + close actions) and a collapsible
    /// "Full Plan" markdown body. The upstream "Steps" section feeds from
    /// `turn.tasks.updated`, which the port does not implement.
    pub(super) fn plan_sidebar(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let plan = self.sidebar_proposed_plan();
        let accent = palette().focus;
        let header_actions = div().flex().items_center().gap_1();
        let header_actions = if let Some(plan) = &plan {
            let copy_markdown = plan.plan_markdown.clone();
            let download_markdown = plan.plan_markdown.clone();
            let download_filename = build_proposed_plan_markdown_filename(&plan.plan_markdown);
            let download_root = self.task().map(|task| task.working_directory.clone());
            header_actions
                .child(
                    ui::chrome_button(
                        "sidebar-copy-plan",
                        "Copy plan",
                        Glyph::Copy,
                        false,
                        cx.listener(move |this, _: &(), _, cx| {
                            cx.write_to_clipboard(ClipboardItem::new_string(copy_markdown.clone()));
                            this.notice = Some("Plan copied as markdown".into());
                            cx.notify();
                        }),
                    )
                    .size(px(24.)),
                )
                .child(
                    ui::chrome_button(
                        "sidebar-download-plan",
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
                )
        } else {
            header_actions
        };
        let header = div()
            .h(px(48.))
            .px_3()
            .flex()
            .items_center()
            .justify_between()
            .border_b_1()
            .border_color(rgb(palette().border))
            .child(
                div().flex().items_center().gap_2().child(
                    div()
                        .px_2()
                        .py_0p5()
                        .rounded_md()
                        .border_1()
                        .border_color(gpui::rgba((accent << 8) | 0x33))
                        .bg(gpui::rgba((accent << 8) | 0x19))
                        .text_size(px(ui::ui_font_size() - 1.))
                        .text_color(rgb(accent))
                        .child("Plan"),
                ),
            )
            .child(
                header_actions.child(
                    ui::chrome_button(
                        "plan-sidebar-close",
                        "Close sidebar",
                        Glyph::PanelRight,
                        false,
                        cx.listener(|this, _: &(), _, cx| {
                            this.plan_sidebar_open = false;
                            cx.notify();
                        }),
                    )
                    .size(px(24.)),
                ),
            );
        let body = div()
            .id("plan-sidebar-body")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .p_3()
            .flex()
            .flex_col()
            .gap_3();
        let body = if let Some(plan) = plan {
            let title =
                proposed_plan_title(&plan.plan_markdown).unwrap_or_else(|| "Full Plan".into());
            let expanded = self.plan_sidebar_expanded;
            body.child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .child(
                        div()
                            .id("plan-sidebar-full-plan")
                            .role(gpui::Role::Button)
                            .aria_label(if expanded {
                                "Collapse plan"
                            } else {
                                "Expand plan"
                            })
                            .tab_index(0)
                            .flex()
                            .items_center()
                            .gap_1p5()
                            .rounded_md()
                            .py_1()
                            .text_size(px(ui::ui_font_size()))
                            .font_weight(FontWeight::MEDIUM)
                            .cursor_pointer()
                            .hover(|style| style.bg(rgb(palette().hover)))
                            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| {
                                this.plan_sidebar_expanded = !this.plan_sidebar_expanded;
                                cx.notify();
                            }))
                            .child(ui::icon(if expanded {
                                Glyph::Chevron
                            } else {
                                Glyph::ChevronRight
                            }))
                            .child(title),
                    )
                    .when(expanded, |section| {
                        section.child(
                            div()
                                .rounded_md()
                                .border_1()
                                .border_color(rgb(palette().border))
                                .bg(rgb(palette().canvas))
                                .p_3()
                                .child(ui::markdown::render(
                                    &plan.plan_markdown,
                                    "plan-sidebar-full",
                                )),
                        )
                    }),
            )
        } else {
            body.child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .gap_1()
                    .py_8()
                    .child(
                        div()
                            .text_size(px(ui::ui_font_size()))
                            .text_color(rgb(palette().muted))
                            .child("No active plan yet."),
                    )
                    .child(
                        div()
                            .text_size(px(ui::ui_font_size() - 1.))
                            .text_color(rgb(palette().muted))
                            .child("Plans will appear here when generated."),
                    ),
            )
        };
        div()
            .w(px(340.))
            .flex_shrink_0()
            .h_full()
            .border_l_1()
            .border_color(rgb(palette().border))
            .bg(gpui::rgba((palette().overlay << 8) | 0x80))
            .flex()
            .flex_col()
            .child(header)
            .child(body)
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
        let runtime = self.runtime.clone();
        let sender = self.sender.clone();
        self.creating_task = true;
        // Upstream `planSidebarOpenOnNextThreadRef`: the plan sidebar opens
        // automatically when the implementation thread is selected.
        self.plan_sidebar_open_next = true;
        self.job(async move {
            let result = async {
                let created = workspace
                    .create_scoped_task(project, title, agent, TaskScope::Project)
                    .await?;
                let records = async {
                    workspace
                        .record(
                            source_thread,
                            ThreadEvent::ProposedPlanImplemented {
                                plan_id: plan_id.clone(),
                                implementation_thread_id: created.thread_id,
                            },
                        )
                        .await?;
                    // Upstream `turn.start`'s `sourceProposedPlan` param: the
                    // implementing turn on the new thread points back at the
                    // source plan (consumed by the next `PromptStarted`).
                    workspace
                        .record(
                            created.thread_id,
                            ThreadEvent::ProposedPlanSource {
                                source_thread,
                                plan_id,
                            },
                        )
                        .await?;
                    Ok::<_, WorkspaceError>(())
                }
                .await;
                if let Err(error) = records {
                    // Upstream deletes the half-created thread when the
                    // implementation dispatch fails.
                    let _ = workspace.delete_task(created.id).await;
                    return Err(error);
                }
                // Upstream selects the new thread, then dispatches
                // `turn.start` — the run continues after navigation while the
                // plan sidebar shows the source plan. Detached so `submit`'s
                // end-to-end await does not postpone `TaskCreated`.
                runtime.spawn({
                    let workspace = workspace.clone();
                    async move {
                        if let Err(error) = controller.submit(created.id, prompt).await {
                            let _ = workspace.delete_task(created.id).await;
                            let _ = sender
                                .send(super::Update::TaskCreationFailed(format!(
                                    "Could not start implementation thread: {error}"
                                )))
                                .await;
                        }
                    }
                });
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
