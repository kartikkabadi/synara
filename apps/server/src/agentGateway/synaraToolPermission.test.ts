import { describe, expect, it } from "vitest";
import {
  canonicalSynaraUnattendedToolName,
  qualifiedSynaraUnattendedToolName,
  shouldAllowSynaraUnattendedProviderTool,
  synaraUnattendedToolNameFromProviderPermission,
} from "./synaraToolPermission.ts";

describe("Synara unattended provider permission", () => {
  it.each([
    ["synara_report_automation_result", "report_automation_result"],
    ["synara_update_automation_memory", "update_automation_memory"],
    ["mcp__synara__synara_read_thread", "read_thread"],
    ["mcp__synara__list_automations", "list_automations"],
    ["synara_synara_view_automation", "view_automation"],
    ["report_automation_result", "report_automation_result"],
  ] as const)("recognizes the owned tool %s", (providerName, canonicalName) => {
    expect(canonicalSynaraUnattendedToolName(providerName)).toBe(canonicalName);
  });

  it.each([
    "synara_send_message",
    "synara_create_thread",
    "synara_set_thread_runtime_mode",
    "mcp__other__synara_read_thread",
    "other_read_thread",
    "mcp__synara__computer_click",
    "synara_future_tool",
  ])("does not trust a mutating or foreign tool: %s", (providerName) => {
    expect(canonicalSynaraUnattendedToolName(providerName)).toBeUndefined();
  });

  it("requires a provider namespace for qualified names", () => {
    expect(qualifiedSynaraUnattendedToolName("report_automation_result")).toBeUndefined();
    expect(qualifiedSynaraUnattendedToolName("synara_report_automation_result")).toBe(
      "report_automation_result",
    );
    expect(qualifiedSynaraUnattendedToolName("mcp__synara__synara_update_automation_memory")).toBe(
      "update_automation_memory",
    );
  });

  it("reads only explicit provider tool-name fields", () => {
    expect(
      synaraUnattendedToolNameFromProviderPermission({
        rawInput: { _toolName: "mcp__synara__synara_list_threads" },
      }),
    ).toBe("list_threads");
    expect(
      synaraUnattendedToolNameFromProviderPermission({
        metadata: { toolName: "synara_e2e_review" },
      }),
    ).toBe("e2e_review");
    expect(
      synaraUnattendedToolNameFromProviderPermission({
        metadata: { description: "run synara_read_thread" },
      }),
    ).toBeUndefined();
  });

  it("does not let lower-priority fields override an authoritative wrong namespace", () => {
    expect(
      synaraUnattendedToolNameFromProviderPermission({
        name: "mcp__other__synara_read_thread",
        rawInput: { _toolName: "mcp__synara__synara_read_thread" },
      }),
    ).toBeUndefined();
  });

  it("allows owned tools only for approval-required active-turn default-mode calls", () => {
    const base = {
      activeTurn: true,
      interactionMode: "default" as const,
      runtimeMode: "approval-required" as const,
      permission: { name: "mcp__synara__synara_report_automation_result" },
    };
    expect(shouldAllowSynaraUnattendedProviderTool(base)).toBe(true);
    expect(shouldAllowSynaraUnattendedProviderTool({ ...base, activeTurn: false })).toBe(false);
    expect(shouldAllowSynaraUnattendedProviderTool({ ...base, runtimeMode: "full-access" })).toBe(
      false,
    );
    expect(
      shouldAllowSynaraUnattendedProviderTool({ ...base, interactionMode: "plan" as const }),
    ).toBe(false);
    expect(
      shouldAllowSynaraUnattendedProviderTool({
        ...base,
        permission: { name: "mcp__synara__synara_send_message" },
      }),
    ).toBe(false);
  });
});
