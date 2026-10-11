import { describe, expect, it } from "vitest";

import {
  APPROVAL_ALREADY_ANSWERED_INVARIANT_MARKER,
  collectErrorMessages,
  describeErrorMessage,
  isTurnMessageAlreadyAcceptedError,
  TURN_MESSAGE_ALREADY_ACCEPTED,
} from "./errorMessages";

describe("errorMessages", () => {
  it("recognizes only the stable duplicate message rejection through RPC wrapping", () => {
    expect(
      isTurnMessageAlreadyAcceptedError({
        message: "RPC rejected",
        cause: new Error(TURN_MESSAGE_ALREADY_ACCEPTED),
      }),
    ).toBe(true);
    expect(isTurnMessageAlreadyAcceptedError(new Error("Provider unavailable"))).toBe(false);
  });
  it("uses Error messages", () => {
    expect(describeErrorMessage(new Error("native binding missing"), "fallback")).toBe(
      "native binding missing",
    );
  });

  it("uses serialized RPC error messages", () => {
    expect(
      describeErrorMessage(
        { _tag: "WsRpcError", message: "Project directory does not exist" },
        "fallback",
      ),
    ).toBe("Project directory does not exist");
  });

  it("includes nested causes without duplicating messages", () => {
    expect(
      describeErrorMessage(
        {
          message: "Failed to load node-pty native module",
          cause: { message: "Cannot find module 'pty.node'" },
        },
        "fallback",
      ),
    ).toBe("Failed to load node-pty native module: Cannot find module 'pty.node'");
  });

  it("avoids cycles in cause chains", () => {
    const error: { message: string; cause?: unknown } = { message: "outer" };
    error.cause = error;

    expect(collectErrorMessages(error)).toEqual(["outer"]);
  });

  it("falls back when no useful message is present", () => {
    expect(describeErrorMessage({ ok: false }, "Failed to open terminal")).toBe(
      "Failed to open terminal",
    );
  });

  it("exposes the stable duplicate-approval invariant marker", () => {
    expect("Approval request 'approval-1' on thread 'thread-1' was already answered.").toContain(
      APPROVAL_ALREADY_ANSWERED_INVARIANT_MARKER,
    );
  });
});
