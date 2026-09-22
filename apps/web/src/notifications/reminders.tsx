// FILE: reminders.tsx
// Purpose: Bridges thread reminder events to in-app toasts and OS notifications.
// Layer: Notification runtime
// Exports: ReminderNotifications (mount once near the root)

import { type ReminderStreamEvent } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { projectNotificationCategoryMuted, useAppSettings } from "../appSettings";
import { readNativeApi } from "../nativeApi";
import { resolveThreadPickerTitle } from "../routes/-chatThreadRoute.logic";
import { useStore } from "../store";
import {
  isNotificationRuntimeFreshTimestamp,
  shouldAttemptSystemTaskNotification,
} from "./taskCompletion.logic";
import {
  isWindowForeground,
  showSystemThreadNotification,
  showThreadToast,
  type ThreadNotificationCopy,
} from "./taskCompletion";
import { useReminderStore } from "./reminderStore";

function reminderCopy(event: Extract<ReminderStreamEvent, { type: "reminder-fired" }>) {
  const title = "Reminder";
  const threadTitle = event.threadTitle ? resolveThreadPickerTitle(event.threadTitle) : "a thread";
  const note = event.reminder.note?.trim();
  return {
    title,
    body: note && note.length > 0 ? note : `Time to check in on ${threadTitle}.`,
  };
}

/** Subscribes to the server's reminder stream for the app session's lifetime. */
export function ReminderNotifications() {
  const { settings } = useAppSettings();
  const navigate = useNavigate();
  const [runtimeStartedAtMs] = useState(() => Date.now());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    const api = readNativeApi();
    if (!api) return;
    const unsubscribe = api.reminder.onEvent((event) => {
      useReminderStore.getState().applyReminderEvent(event);
      if (event.type !== "reminder-fired") return;
      // A replayed snapshot (reconnect) must not re-notify reminders that fired
      // before this runtime started; only genuinely fresh fires notify.
      if (
        event.reminder.firedAt !== null &&
        !isNotificationRuntimeFreshTimestamp(event.reminder.firedAt, runtimeStartedAtMs)
      ) {
        return;
      }
      const current = settingsRef.current;
      if (
        event.projectId !== undefined &&
        projectNotificationCategoryMuted(
          current.projectNotificationPrefs[event.projectId],
          "reminders",
        )
      ) {
        return;
      }
      // A fired reminder resurfaces the thread: unread badge even if every
      // notification channel is muted, since the reminder was user-requested.
      useStore.getState().markThreadUnread(event.reminder.threadId);
      const copy: ThreadNotificationCopy = reminderCopy(event);
      if (current.enableTaskCompletionToasts) {
        showThreadToast(copy, event.reminder.threadId, "warning", navigate);
      }
      if (
        shouldAttemptSystemTaskNotification({
          enabled: current.enableSystemTaskCompletionNotifications,
          isWindowForeground: isWindowForeground(),
        })
      ) {
        void showSystemThreadNotification(copy, event.reminder.threadId, navigate);
      }
    });
    return unsubscribe;
  }, [navigate, runtimeStartedAtMs]);

  return null;
}
