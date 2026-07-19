/**
 * Devin ACP elicitation helpers — pure mapping between ACP elicitation schemas
 * and Synara user-input contracts.
 *
 * @module DevinElicitation
 */
import type { UserInputQuestion } from "@synara/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { runInNewContext } from "node:vm";

type ElicitationForm = Extract<EffectAcpSchema.ElicitationRequest, { mode: "form" }>;
type ElicitationProperty = EffectAcpSchema.ElicitationPropertySchema;
type ElicitationContentValue = EffectAcpSchema.ElicitationContentValue;

const FALLBACK_OPTIONS = [{ label: "OK", description: "Continue" }] as const;
const FREEFORM_OPTIONS: ReadonlyArray<{ label: string; description: string }> = [];
const REGEX_TIMEOUT_MS = 100;

// Defense-in-depth limits for provider-controlled elicitation forms.
const MAX_ELICITATION_PROPERTIES = 50;
const MAX_ELICITATION_SCHEMA_SIZE_BYTES = 100_000;
const MAX_ELICITATION_ANSWER_SIZE_BYTES = 100_000;
const MAX_ELICITATION_TOTAL_ANSWER_SIZE_BYTES = 500_000;

type RegexMatchResult =
  | { readonly ok: true; readonly matched: boolean }
  | { readonly ok: false; readonly reason: "timeout" | "invalid" };

/**
 * Tests `input` against `pattern` inside an isolated V8 context with a hard
 * wall-clock timeout. This makes provider-controlled regex validation
 * interruptible: catastrophic backtracking cannot block the process forever.
 */
function isTimeoutError(error: unknown): boolean {
  // vm.runInNewContext throws errors from the created context, so the error
  // is not an instance of the main realm's Error class. Inspect the message.
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string" &&
    (error as { message: string }).message.includes("Script execution timed out")
  );
}

function testPatternInterruptibly(pattern: string, input: string): RegexMatchResult {
  try {
    const matched = runInNewContext(
      `new RegExp(pattern).test(input)`,
      { pattern, input },
      { timeout: REGEX_TIMEOUT_MS },
    ) as boolean;
    return { ok: true, matched };
  } catch (error) {
    if (isTimeoutError(error)) {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "invalid" };
  }
}

export function validateElicitationRequest(
  request: ElicitationForm,
): DevinElicitationValidationResult {
  const issues: string[] = [];
  const properties = request.requestedSchema.properties;
  const propertyCount = properties ? Object.keys(properties).length : 0;
  if (propertyCount > MAX_ELICITATION_PROPERTIES) {
    issues.push(
      `Elicitation form has ${propertyCount} properties; maximum is ${MAX_ELICITATION_PROPERTIES}.`,
    );
  }
  try {
    const serialized = JSON.stringify(request);
    if (serialized.length > MAX_ELICITATION_SCHEMA_SIZE_BYTES) {
      issues.push(
        `Elicitation form exceeds maximum size of ${MAX_ELICITATION_SCHEMA_SIZE_BYTES} bytes.`,
      );
    }
  } catch {
    issues.push("Elicitation form is not serializable.");
  }
  return { valid: issues.length === 0, issues };
}

export function elicitationFormToUserInputQuestions(
  request: ElicitationForm,
): ReadonlyArray<UserInputQuestion> {
  const properties = request.requestedSchema.properties;
  const requiredKeys = new Set(request.requestedSchema.required ?? []);
  if (!properties || Object.keys(properties).length === 0) {
    return [
      {
        id: "response",
        header: "Devin",
        question: request.message,
        options: [...FALLBACK_OPTIONS],
      },
    ];
  }

  return Object.entries(properties).map(([key, prop]) => ({
    id: key,
    header: prop.title?.trim() || key,
    question: prop.description?.trim() || request.message,
    options: propertyOptions(prop),
    multiSelect: prop.type === "array",
    optional: !requiredKeys.has(key),
  }));
}

function propertyOptions(
  prop: ElicitationProperty,
): ReadonlyArray<{ label: string; description: string }> {
  switch (prop.type) {
    case "string":
      if (prop.enum && prop.enum.length > 0) {
        return prop.enum.map((v) => ({ label: v, description: v }));
      }
      if (prop.oneOf && prop.oneOf.length > 0) {
        return prop.oneOf.map((opt) => ({
          label: opt.const,
          description: opt.title || opt.const,
        }));
      }
      return FREEFORM_OPTIONS;

    case "boolean":
      return [
        { label: "Yes", description: "Yes" },
        { label: "No", description: "No" },
      ];

    case "number":
    case "integer":
      return FREEFORM_OPTIONS;

    case "array": {
      const items = prop.items;
      if ("enum" in items && Array.isArray(items.enum) && items.enum.length > 0) {
        return items.enum.map((v) => ({ label: v, description: v }));
      }
      if ("anyOf" in items && Array.isArray(items.anyOf) && items.anyOf.length > 0) {
        return items.anyOf.map((opt) => ({
          label: opt.const,
          description: opt.title || opt.const,
        }));
      }
      return FREEFORM_OPTIONS;
    }

    default:
      return FREEFORM_OPTIONS;
  }
}

export interface DevinElicitationValidationResult {
  readonly valid: boolean;
  readonly issues: ReadonlyArray<string>;
}

/**
 * Validates submitted user-input answers against a Devin ACP form elicitation
 * request before the adapter resolves the pending deferred.
 *
 * Pure and total: never throws; invalid input yields `valid: false` with
 * human-readable issue strings. Null answers mean "skipped" and are only
 * invalid when the property is listed in `requestedSchema.required`.
 */
export function validateUserInputAnswersForElicitation(
  request: ElicitationForm,
  answers: Record<string, string | ReadonlyArray<string> | null>,
): DevinElicitationValidationResult {
  const properties = request.requestedSchema.properties;
  const hasProperties = properties !== undefined && Object.keys(properties).length > 0;
  const propertyCount = properties ? Object.keys(properties).length : 0;
  const issues: string[] = [];

  if (propertyCount > MAX_ELICITATION_PROPERTIES) {
    issues.push(
      `Elicitation form has ${propertyCount} properties; maximum is ${MAX_ELICITATION_PROPERTIES}.`,
    );
  }

  let totalAnswerSize = 0;
  for (const [key, value] of Object.entries(answers)) {
    if (value === null || value === undefined) continue;
    const size =
      typeof value === "string"
        ? value.length
        : (value as ReadonlyArray<string>).reduce((sum, item) => sum + item.length, 0);
    if (size > MAX_ELICITATION_ANSWER_SIZE_BYTES) {
      issues.push(
        `Answer '${key}' exceeds the maximum allowed size of ${MAX_ELICITATION_ANSWER_SIZE_BYTES} bytes.`,
      );
    }
    totalAnswerSize += size;
    if (totalAnswerSize > MAX_ELICITATION_TOTAL_ANSWER_SIZE_BYTES) {
      issues.push(
        `Total elicitation answer size exceeds the maximum allowed ${MAX_ELICITATION_TOTAL_ANSWER_SIZE_BYTES} bytes.`,
      );
      break;
    }
  }

  // unknown keys: only the synthetic "response" key is allowed when the form has no properties
  for (const key of Object.keys(answers)) {
    if (hasProperties) {
      if (!Object.hasOwn(properties, key)) {
        issues.push(`Unknown answer key '${key}'.`);
      }
    } else if (key !== "response") {
      issues.push(`Unknown answer key '${key}'; expected only 'response'.`);
    }
  }

  // required properties must be present and non-null
  for (const key of request.requestedSchema.required ?? []) {
    if (answers[key] === undefined || answers[key] === null) {
      issues.push(`Missing required answer '${key}'.`);
    }
  }

  // per-property value validation
  if (hasProperties) {
    for (const [key, value] of Object.entries(answers)) {
      const prop = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (!prop || value === null) continue;
      const issue = validateAnswerValue(key, prop, value);
      if (issue !== undefined) {
        issues.push(issue);
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

function validateAnswerValue(
  key: string,
  prop: ElicitationProperty,
  value: string | ReadonlyArray<string>,
): string | undefined {
  switch (prop.type) {
    case "string": {
      const raw = normalizeStringValue(value);
      if (prop.enum && prop.enum.length > 0 && !prop.enum.includes(raw)) {
        return `Answer '${key}' must be one of: ${prop.enum.join(", ")}.`;
      }
      if (prop.oneOf && prop.oneOf.length > 0) {
        const allowed = prop.oneOf.map((opt) => opt.const);
        if (!allowed.includes(raw)) {
          return `Answer '${key}' must be one of: ${allowed.join(", ")}.`;
        }
      }
      if (prop.minLength !== undefined && prop.minLength !== null && raw.length < prop.minLength) {
        return `Answer '${key}' must be at least ${prop.minLength} characters.`;
      }
      if (prop.maxLength !== undefined && prop.maxLength !== null && raw.length > prop.maxLength) {
        return `Answer '${key}' must be at most ${prop.maxLength} characters.`;
      }
      if (prop.pattern !== undefined && prop.pattern !== null) {
        // Defense-in-depth against catastrophic backtracking (ReDoS): the
        // pattern comes from an external ACP provider and raw is user input.
        // Cap pattern length and input length before compilation, and run the
        // match inside an isolated V8 context with a hard wall-clock timeout so
        // a pathological regex cannot block the server event loop.
        const MAX_PATTERN_LENGTH = 200;
        const REJECT_INPUT_LENGTH = 10_000;
        if (prop.pattern.length > MAX_PATTERN_LENGTH) {
          return `Answer '${key}' has an invalid pattern constraint.`;
        }
        if (raw.length > REJECT_INPUT_LENGTH) {
          return `Answer '${key}' exceeds the maximum allowed length.`;
        }
        const result = testPatternInterruptibly(prop.pattern, raw);
        if (!result.ok) {
          return result.reason === "timeout"
            ? `Answer '${key}' did not satisfy the pattern constraint within the allowed time.`
            : `Answer '${key}' has an invalid pattern constraint.`;
        }
        if (!result.matched) {
          return `Answer '${key}' must match pattern ${prop.pattern}.`;
        }
      }
      return undefined;
    }

    case "boolean":
      return normalizeBooleanValue(value) === undefined
        ? `Answer '${key}' must be Yes, No, true, or false.`
        : undefined;

    case "number":
    case "integer": {
      const num = normalizeNumericValue(value);
      if (num === undefined) {
        return `Answer '${key}' must be a finite number.`;
      }
      if (prop.type === "integer" && !Number.isInteger(num)) {
        return `Answer '${key}' must be an integer.`;
      }
      if (prop.minimum !== undefined && prop.minimum !== null && num < prop.minimum) {
        return `Answer '${key}' must be >= ${prop.minimum}.`;
      }
      if (prop.maximum !== undefined && prop.maximum !== null && num > prop.maximum) {
        return `Answer '${key}' must be <= ${prop.maximum}.`;
      }
      return undefined;
    }

    case "array": {
      const selected = Array.isArray(value) ? value : [String(value)];
      const items = prop.items;
      const allowed =
        "enum" in items && Array.isArray(items.enum)
          ? items.enum
          : "anyOf" in items && Array.isArray(items.anyOf)
            ? items.anyOf.map((opt) => opt.const)
            : undefined;
      if (allowed && allowed.length > 0) {
        const disallowed = selected.filter((entry) => !allowed.includes(entry));
        if (disallowed.length > 0) {
          return `Answer '${key}' contains disallowed values: ${disallowed.join(", ")}. Allowed: ${allowed.join(", ")}.`;
        }
      }
      if (
        prop.minItems !== undefined &&
        prop.minItems !== null &&
        selected.length < prop.minItems
      ) {
        return `Answer '${key}' must have at least ${prop.minItems} items.`;
      }
      if (
        prop.maxItems !== undefined &&
        prop.maxItems !== null &&
        selected.length > prop.maxItems
      ) {
        return `Answer '${key}' must have at most ${prop.maxItems} items.`;
      }
      return undefined;
    }

    default:
      return undefined;
  }
}

export function userInputAnswersToElicitationContent(
  request: ElicitationForm,
  answers: Record<string, string | ReadonlyArray<string> | null>,
): Record<string, ElicitationContentValue> {
  const schema = request.requestedSchema.properties;
  const content: Record<string, ElicitationContentValue> = {};

  for (const [key, value] of Object.entries(answers)) {
    if (value === null) continue;

    const prop = schema?.[key];
    if (!prop) {
      if (key === "response" && (!schema || Object.keys(schema).length === 0)) {
        content[key] = normalizeStringValue(value);
      }
      continue;
    }

    switch (prop.type) {
      case "boolean": {
        const normalized = normalizeBooleanValue(value);
        if (normalized !== undefined) {
          content[key] = normalized;
        }
        continue;
      }

      case "number":
      case "integer": {
        const num = normalizeNumericValue(value);
        if (num !== undefined) {
          content[key] = num;
        }
        continue;
      }

      case "array":
        content[key] = Array.isArray(value) ? [...value] : [String(value)];
        break;

      case "string":
      default:
        content[key] = normalizeStringValue(value);
        break;
    }
  }

  return content;
}

function normalizeStringValue(value: string | ReadonlyArray<string>): string {
  if (typeof value === "string") return value;
  return value.join(", ");
}

function normalizeNumericValue(value: string | ReadonlyArray<string>): number | undefined {
  const raw =
    typeof value === "string" ? value.trim() : value.length === 1 ? (value[0]?.trim() ?? "") : "";
  if (!raw) return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}

function normalizeBooleanValue(value: string | ReadonlyArray<string>): boolean | undefined {
  // For boolean fields, use only the first element of an array.
  const raw = typeof value === "string" ? value : value.length > 0 ? value[0] : undefined;
  if (raw === undefined) return undefined;
  const lowered = raw.trim().toLowerCase();
  if (lowered === "yes" || lowered === "true") return true;
  if (lowered === "no" || lowered === "false") return false;
  return undefined;
}
