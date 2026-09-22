// FILE: runEnvelope.ts
// Purpose: Builds the single canonical synthetic message sent to automation runs.

import type {
  AutomationDefinition,
  AutomationEventRunContext,
  AutomationRun,
  AutomationTrigger,
} from "@synara/contracts";
import { automationContinuesThread, automationOwnsItsThread } from "@synara/shared/automationMode";

export const AUTOMATION_MEMORY_INJECTION_MAX_BYTES = 8 * 1_024;
export const AUTOMATION_MEMORY_TRUNCATION_MARKER = "[... older automation memory truncated ...]\n";

export function automationMemoryForEnvelope(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.byteLength <= AUTOMATION_MEMORY_INJECTION_MAX_BYTES) {
    return content || "(empty)";
  }

  const marker = Buffer.from(AUTOMATION_MEMORY_TRUNCATION_MARKER, "utf8");
  const suffixBudget = AUTOMATION_MEMORY_INJECTION_MAX_BYTES - marker.byteLength;
  let start = Math.max(0, bytes.byteLength - suffixBudget);
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) {
    start += 1;
  }
  return `${AUTOMATION_MEMORY_TRUNCATION_MARKER}${bytes.subarray(start).toString("utf8")}`;
}

function iterationLabel(definition: AutomationDefinition, run: AutomationRun): string {
  const iteration = run.permissionSnapshot.iterationNumber ?? definition.iterationCount + 1;
  return `${iteration}/${definition.maxIterations ?? "∞"}`;
}

// Every mode may retire its own automation: the run-scoped authorization in
// synara_cancel_automation covers standalone runs, whose per-run thread owns nothing else.
const SELF_CANCEL_INSTRUCTION =
  "You may call synara_cancel_automation on this automation when it is no longer needed.";

function reportingInstructions(mode: AutomationDefinition["mode"]): string {
  // A run that continues a thread leaves its work visible in that thread, so it reports
  // only what the user still needs to see. A run with a thread to itself reports fully.
  if (automationContinuesThread(mode)) {
    return [
      "Before finishing, call synara_report_automation_result.",
      'Use decision "silent" when nothing needs the user\'s attention; otherwise use "notify".',
      SELF_CANCEL_INSTRUCTION,
    ].join(" ");
  }
  return [
    "Before finishing, call synara_report_automation_result with a concise title and summary.",
    'Use decision "notify" unless the successful run genuinely requires no user attention.',
    SELF_CANCEL_INSTRUCTION,
  ].join(" ");
}

function threadScopeLine(definition: AutomationDefinition): string | null {
  if (automationOwnsItsThread(definition.mode)) {
    return "Thread scope: this thread belongs to this automation and is reused by every run, so earlier runs are above and your work stays visible to the next one.";
  }
  if (automationContinuesThread(definition.mode)) {
    return "Thread scope: this is the thread the automation drives; it may also carry the user's own turns.";
  }
  return null;
}

// Event triggers substitute `{{placeholder}}` tokens in the stored prompt with the
// dispatching event's fields. Unknown tokens stay literal so prose braces survive.
const AUTOMATION_EVENT_PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z]+)\s*\}\}/g;

function renderAutomationPromptTemplate(prompt: string, trigger: AutomationTrigger): string {
  if (trigger.type !== "event") return prompt;
  const { event } = trigger;
  const values: Record<string, string> = {
    repository: event.repository,
    title: event.title,
    url: event.url,
    author: event.author ?? "",
    itemNumber: String(event.itemNumber),
    baseBranch: event.baseBranch ?? "",
    event: event.event,
    key: event.key,
  };
  return prompt.replace(AUTOMATION_EVENT_PLACEHOLDER_PATTERN, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name]! : match,
  );
}

function eventContextLine(event: AutomationEventRunContext): string {
  return [
    `Event: ${event.event} — ${event.repository}#${event.itemNumber} "${event.title}" (${event.url})`,
    ...(event.author ? [`by ${event.author}`] : []),
    ...(event.baseBranch ? [`on branch ${event.baseBranch}`] : []),
  ].join(" ");
}

export function buildAutomationRunEnvelope(input: {
  readonly definition: AutomationDefinition;
  readonly run: AutomationRun;
  readonly memoryContent: string;
  readonly lastRunAt: string | null;
}): string {
  const { definition, run } = input;
  const threadScope = threadScopeLine(definition);
  return [
    `Automation: ${definition.name}`,
    `Automation ID: ${definition.id}`,
    `Run: ${run.trigger.type}, scheduled for ${run.scheduledFor} (last run: ${
      input.lastRunAt ?? "never"
    }, iteration ${iterationLabel(definition, run)})`,
    ...(run.trigger.type === "event" ? [eventContextLine(run.trigger.event)] : []),
    "Turn scope: this user message is the automation-dispatched turn. These automation-only completion duties do not carry into later manual follow-up turns.",
    ...(threadScope ? [threadScope] : []),
    'Memory (persistent across runs — replace it via synara_update_automation_memory {"memory": "..."} before finishing):',
    automationMemoryForEnvelope(input.memoryContent),
    "",
    reportingInstructions(definition.mode),
    "",
    "---",
    "",
    renderAutomationPromptTemplate(definition.prompt, run.trigger),
  ].join("\n");
}
