import type { ProviderInteractionMode, RuntimeMode } from "@synara/contracts";

/**
 * Synara-owned gateway tools a provider must not gate behind a human approval
 * when a session already runs unattended.
 *
 * Two groups:
 * - Read-only tools (`synara_context`, `synara_list_*`, `synara_read_*`,
 *   `synara_view_automation`, ...). They cannot mutate anything beyond what the
 *   session lease already exposes, so a per-call human prompt is friction, not
 *   consent.
 * - Run-lifecycle bookkeeping (`synara_update_automation_memory`,
 *   `synara_report_automation_result`). Harness policy REQUIRES automations to
 *   report their result; gating those calls stalls every run at its last step.
 *
 * Everything else in the `synara_*` family — thread creation, messaging,
 * interruption, archiving, automation CRUD — stays human-approved: unattended
 * approval there would silently remove the only consent gate.
 */
export const SYNARA_UNATTENDED_TOOL_NAMES = [
  "context",
  "capabilities",
  "list_projects",
  "list_threads",
  "read_thread",
  "wait_for_threads",
  "read_thread_activity",
  "diagnose_thread",
  "read_thread_events",
  "read_thread_runtime_events",
  "list_automations",
  "view_automation",
  "e2e_review",
  "update_automation_memory",
  "report_automation_result",
] as const;

export type SynaraUnattendedToolName = (typeof SYNARA_UNATTENDED_TOOL_NAMES)[number];

const SYNARA_UNATTENDED_TOOL_NAME_SET = new Set<string>(SYNARA_UNATTENDED_TOOL_NAMES);

function recordString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = Reflect.get(value, key);
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * Accept only the canonical gateway name or the exact provider qualifications
 * used for Synara's reserved MCP server. Wire spellings seen in the wild:
 * `synara_report_automation_result` (server-named tool),
 * `mcp__synara__synara_report_automation_result` (MCP-qualified), and
 * `synara_synara_report_automation_result` (provider name-prefix form). A
 * similarly named tool from another MCP server must continue through the
 * provider's ordinary permission policy.
 */
export function canonicalSynaraUnattendedToolName(
  value: unknown,
): SynaraUnattendedToolName | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  const unqualified = normalized.startsWith("mcp__synara__")
    ? normalized.slice("mcp__synara__".length)
    : normalized;
  // Catalog names already carry a `synara_` prefix, so the provider name-prefix
  // form (`synara_` + catalog) needs repeated stripping to reach the bare name.
  let canonical = unqualified;
  while (canonical.startsWith("synara_") && !SYNARA_UNATTENDED_TOOL_NAME_SET.has(canonical)) {
    canonical = canonical.slice("synara_".length);
  }
  return SYNARA_UNATTENDED_TOOL_NAME_SET.has(canonical)
    ? (canonical as SynaraUnattendedToolName)
    : undefined;
}

/**
 * Provider callbacks must carry Synara's namespace themselves. Bare canonical
 * names are safe only after a separate protocol field has proved the server
 * identity (for example Codex's `serverName`).
 */
export function qualifiedSynaraUnattendedToolName(
  value: unknown,
): SynaraUnattendedToolName | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized.startsWith("mcp__synara__") && !normalized.startsWith("synara_")) {
    return undefined;
  }
  return canonicalSynaraUnattendedToolName(normalized);
}

function firstRecordString(value: unknown, keys: ReadonlyArray<string>): string | undefined {
  for (const key of keys) {
    const candidate = recordString(value, key);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

export function synaraUnattendedToolNameFromProviderPermission(input: {
  readonly name?: unknown;
  readonly title?: unknown;
  readonly rawInput?: unknown;
  readonly metadata?: unknown;
}): SynaraUnattendedToolName | undefined {
  const explicitName = typeof input.name === "string" ? input.name : undefined;
  if (explicitName !== undefined) return qualifiedSynaraUnattendedToolName(explicitName);

  const rawToolName = firstRecordString(input.rawInput, ["_toolName", "toolName", "tool_name"]);
  if (rawToolName !== undefined) return qualifiedSynaraUnattendedToolName(rawToolName);

  const metadataToolName = firstRecordString(input.metadata, [
    "_toolName",
    "toolName",
    "tool_name",
  ]);
  if (metadataToolName !== undefined) return qualifiedSynaraUnattendedToolName(metadataToolName);

  return qualifiedSynaraUnattendedToolName(input.title);
}

/**
 * Provider permission prompts are redundant for Synara-owned read-only and
 * run-lifecycle tools: the gateway's session lease already scopes what they may
 * reach, and automations run without a human watching each thread. Plan mode
 * and requests outside an active turn remain fail-closed.
 */
export function shouldAllowSynaraUnattendedProviderTool(input: {
  readonly activeTurn: boolean;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly permission: Parameters<typeof synaraUnattendedToolNameFromProviderPermission>[0];
}): boolean {
  return (
    input.activeTurn &&
    input.runtimeMode === "approval-required" &&
    input.interactionMode === "default" &&
    synaraUnattendedToolNameFromProviderPermission(input.permission) !== undefined
  );
}
