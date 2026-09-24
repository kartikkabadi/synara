// FILE: reminderStore.ts
// Purpose: Client-side mirror of pending thread reminders, kept in sync by the
// server's reminder event stream (snapshot + upserted/deleted/fired). Lets UI
// surfaces like the thread context menu read reminder state without an RPC per
// interaction.
// Layer: Notification runtime
// Exports: useReminderStore, pendingReminderForThread

import type { ReminderStreamEvent, ThreadId, ThreadReminder } from "@synara/contracts";
import { create } from "zustand";

type PendingReminderMap = Readonly<Record<string, ThreadReminder>>;

function onlyPending(reminders: ReadonlyArray<ThreadReminder>): PendingReminderMap {
  const map: Record<string, ThreadReminder> = {};
  for (const reminder of reminders) {
    if (reminder.firedAt === null) map[reminder.threadId] = reminder;
  }
  return map;
}

interface ReminderStore {
  readonly pending: PendingReminderMap;
  readonly applyReminderEvent: (event: ReminderStreamEvent) => void;
}

export const useReminderStore = create<ReminderStore>((set) => ({
  pending: {},
  applyReminderEvent: (event) =>
    set((state) => {
      if (event.type === "snapshot") {
        return { pending: onlyPending(event.reminders) };
      }
      if (event.type === "reminder-deleted") {
        if (state.pending[event.threadId] === undefined) return state;
        const next = { ...state.pending };
        delete next[event.threadId];
        return { pending: next };
      }
      const reminder = event.reminder;
      if (reminder.firedAt !== null) {
        if (state.pending[reminder.threadId] === undefined) return state;
        const next = { ...state.pending };
        delete next[reminder.threadId];
        return { pending: next };
      }
      return { pending: { ...state.pending, [reminder.threadId]: reminder } };
    }),
}));

/** Pending (unfired) reminder for one thread, or null when none is scheduled. */
export function pendingReminderForThread(threadId: ThreadId | string): ThreadReminder | null {
  return useReminderStore.getState().pending[threadId] ?? null;
}
