import { Cause } from "effect";
import { describe, expect, it as vitestIt } from "vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  assistantItemId,
  causeIndicatesAuthRequired,
  isAcpAuthRequiredError,
} from "./AcpSessionRuntime.ts";

describe("isAcpAuthRequiredError", () => {
  vitestIt("returns true for ACP auth-required code (-32000)", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -32000,
      errorMessage: "Some error",
    });
    expect(isAcpAuthRequiredError(error)).toBe(true);
  });

  vitestIt("returns true when errorMessage contains 'authentication required'", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -1,
      errorMessage: "Authentication required",
    });
    expect(isAcpAuthRequiredError(error)).toBe(true);
  });

  vitestIt("returns false for unrelated errors", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -1,
      errorMessage: "the author field is missing",
    });
    expect(isAcpAuthRequiredError(error)).toBe(false);
  });

  vitestIt("returns false for non-AcpRequestError tags", () => {
    const error = new EffectAcpErrors.AcpSpawnError({
      command: "devin",
      cause: new Error("spawn failed"),
    });
    expect(isAcpAuthRequiredError(error)).toBe(false);
  });

  vitestIt("returns true when errorMessage contains 'authorization required'", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -1,
      errorMessage: "Authorization required",
    });
    expect(isAcpAuthRequiredError(error)).toBe(true);
  });

  vitestIt("returns true when errorMessage contains 'authentication expired'", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -1,
      errorMessage: "Authentication expired",
    });
    expect(isAcpAuthRequiredError(error)).toBe(true);
  });

  vitestIt("returns true when errorMessage contains 'auth' as a standalone word", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -1,
      errorMessage: "Auth required for this action",
    });
    expect(isAcpAuthRequiredError(error)).toBe(true);
  });

  vitestIt(
    "returns false when errorMessage contains 'authoring' (not 'auth' as a word boundary)",
    () => {
      const error = new EffectAcpErrors.AcpRequestError({
        code: -1,
        errorMessage: "authoring mode is not supported",
      });
      expect(isAcpAuthRequiredError(error)).toBe(false);
    },
  );

  vitestIt("returns true for code -32000 regardless of errorMessage content", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -32000,
      errorMessage: "something unrelated",
    });
    expect(isAcpAuthRequiredError(error)).toBe(true);
  });
});

describe("causeIndicatesAuthRequired", () => {
  vitestIt("returns true for a Fail cause with auth-required code", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -32000,
      errorMessage: "Unauthorized",
    });
    const cause = Cause.fail(error);
    expect(causeIndicatesAuthRequired(cause)).toBe(true);
  });

  vitestIt("returns true for a Die cause with 'authentication failed' message", () => {
    const cause = Cause.die(new Error("Devin authentication failed"));
    expect(causeIndicatesAuthRequired(cause)).toBe(true);
  });

  vitestIt(
    "returns false when Cause.pretty would contain 'auth' in a path but there is no auth failure",
    () => {
      const cause = Cause.die(new Error("Module not found: /src/auth/utils.ts"));
      expect(causeIndicatesAuthRequired(cause)).toBe(false);
    },
  );

  vitestIt("returns false for a Die cause with 'the author field is missing'", () => {
    const cause = Cause.die(new Error("the author field is missing"));
    expect(causeIndicatesAuthRequired(cause)).toBe(false);
  });

  vitestIt("returns false for a plain non-auth Fail cause", () => {
    const error = new EffectAcpErrors.AcpRequestError({
      code: -32603,
      errorMessage: "Internal error",
    });
    const cause = Cause.fail(error);
    expect(causeIndicatesAuthRequired(cause)).toBe(false);
  });

  vitestIt("returns true for a Die cause with 'authorization required' message", () => {
    const cause = Cause.die(new Error("Authorization required"));
    expect(causeIndicatesAuthRequired(cause)).toBe(true);
  });

  vitestIt("returns true for a Die cause with 'authentication expired' message", () => {
    const cause = Cause.die(new Error("Authentication expired"));
    expect(causeIndicatesAuthRequired(cause)).toBe(true);
  });

  vitestIt("returns true for a Die cause with 'auth required' message", () => {
    const cause = Cause.die(new Error("Auth required"));
    expect(causeIndicatesAuthRequired(cause)).toBe(true);
  });

  vitestIt("returns false for a Die cause with a non-auth error", () => {
    const cause = Cause.die(new Error("Internal server error"));
    expect(causeIndicatesAuthRequired(cause)).toBe(false);
  });

  vitestIt("returns false for a Die cause with a non-string defect (number)", () => {
    const cause = Cause.die(42);
    expect(causeIndicatesAuthRequired(cause)).toBe(false);
  });

  vitestIt("returns false for a Die cause with a non-string defect (object)", () => {
    const cause = Cause.die({ foo: "bar" });
    expect(causeIndicatesAuthRequired(cause)).toBe(false);
  });

  vitestIt("returns false for an Empty cause", () => {
    expect(causeIndicatesAuthRequired(Cause.empty)).toBe(false);
  });
});

describe("assistantItemId", () => {
  // Format contract only — distinct runtimeInstanceId wiring is covered by
  // AcpJsonRpcConnection.test.ts ("assigns distinct fallback assistant item ids...").
  vitestIt(
    "produces distinct ids across runtime instances with the same session id and segment index",
    () => {
      const sessionId = "session-1";
      const a = assistantItemId(sessionId, "aaaa1111", 0);
      const b = assistantItemId(sessionId, "bbbb2222", 0);
      expect(a).not.toBe(b);
      expect(a).toBe("assistant:session-1:aaaa1111:segment:0");
      expect(b).toBe("assistant:session-1:bbbb2222:segment:0");
    },
  );
});

describe("decodeSetSessionConfigOptionResponse", () => {
  const configOptions = [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "gpt-5.6-luna",
      options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
    },
  ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

  it("uses the matching config update for an empty response", () => {
    const decoded = Effect.runSync(
      decodeSetSessionConfigOptionResponse({}, Effect.succeed(configOptions)),
    );
    expect(decoded).toEqual({ configOptions });
  });

  it("strictly decodes a non-empty response without awaiting an update", () => {
    let awaitedUpdate = false;
    const decoded = Effect.runSync(
      decodeSetSessionConfigOptionResponse(
        { configOptions },
        Effect.sync(() => {
          awaitedUpdate = true;
          return [];
        }),
      ),
    );
    expect(decoded).toEqual({ configOptions });
    expect(awaitedUpdate).toBe(false);
  });

  it("rejects an invalid non-empty response", async () => {
    const error = await Effect.runPromise(
      decodeSetSessionConfigOptionResponse(
        { unexpected: true },
        Effect.succeed(configOptions),
      ).pipe(Effect.flip),
    );
    expect(error._tag).toBe("AcpTransportError");
    if (error._tag === "AcpTransportError") {
      expect(error.detail).toContain("invalid session/set_config_option response");
    }
  });
});

describe("sessionConfigOptionsFromSetup", () => {
  const replayedConfigOptions = [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "gpt-5.6-luna",
      options: [{ value: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
    },
  ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

  it("preserves config retained from replay when setup omits configOptions", () => {
    expect(sessionConfigOptionsFromSetup({}, replayedConfigOptions)).toBe(replayedConfigOptions);
  });

  it("uses an explicit setup inventory instead of replayed config", () => {
    expect(sessionConfigOptionsFromSetup({ configOptions: [] }, replayedConfigOptions)).toEqual([]);
  });
});
