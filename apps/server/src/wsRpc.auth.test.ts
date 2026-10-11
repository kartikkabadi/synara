import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import { AuthError } from "./auth/Services/ServerAuth";
import {
  getControlPlaneJob,
  listUncertainRevertJobs,
  resolveUncertainRevertJob,
} from "./controlPlaneOperator";
import { makeDisabledKernel } from "./persistence/Layers/ControlPlaneKernel";
import type { ControlPlaneKernelShape } from "./persistence/Services/ControlPlaneKernel";
import { CurrentWsSessionRole } from "./wsConnectionSessions";
import {
  authenticateRpcWebSocketUpgrade,
  canManageExternalMcp,
  requireControlPlaneOperator,
} from "./wsRpc";

it("reserves external MCP management for owner sessions", () => {
  assert.isTrue(canManageExternalMcp("owner"));
  assert.isFalse(canManageExternalMcp("client"));
});

const makeTrackedKernel = () => {
  let touches = 0;
  const kernel: ControlPlaneKernelShape = {
    ...makeDisabledKernel("unused"),
    mode: "on",
    job: () => Effect.sync(() => ((touches += 1), null)),
    jobsPage: () => Effect.sync(() => ((touches += 1), { jobs: [], nextAfterSequence: 0 })),
    resolveUncertainJobs: () =>
      Effect.sync(
        () => ((touches += 1), { transactionId: "t", transactionSequence: 1, committedAtMs: 0 }),
      ),
  };
  return { kernel, kernelTouches: () => touches };
};

it.effect(
  "rejects control-plane operator calls from non-owner sessions without touching the kernel",
  () =>
    Effect.gen(function* () {
      const { kernel, kernelTouches } = makeTrackedKernel();
      const guarded = [
        requireControlPlaneOperator.pipe(
          Effect.andThen(listUncertainRevertJobs(kernel, {})),
          Effect.asVoid,
        ),
        requireControlPlaneOperator.pipe(
          Effect.andThen(getControlPlaneJob(kernel, { jobId: "a".repeat(32) })),
          Effect.asVoid,
        ),
        requireControlPlaneOperator.pipe(
          Effect.andThen(
            resolveUncertainRevertJob(kernel, { jobId: "a".repeat(32), resolution: "retry" }),
          ),
          Effect.asVoid,
        ),
      ];
      for (const effect of guarded) {
        const error = yield* effect.pipe(
          Effect.provideService(CurrentWsSessionRole, "client"),
          Effect.flip,
        );
        assert.equal(error.message, "Owner authorization is required for this operation.");
      }
      assert.equal(kernelTouches(), 0);
    }),
);

it.effect("allows control-plane operator calls from owner sessions", () =>
  Effect.gen(function* () {
    const { kernel, kernelTouches } = makeTrackedKernel();
    yield* requireControlPlaneOperator.pipe(
      Effect.andThen(listUncertainRevertJobs(kernel, {})),
      Effect.provideService(CurrentWsSessionRole, "owner"),
    );
    assert.equal(kernelTouches(), 1);
  }),
);

it.effect("rejects an unauthorized websocket upgrade on a non-loopback bind", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(
        new AuthError({
          message: "Authentication required.",
          status: 401,
        }),
      ),
    );

    const error = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "0.0.0.0", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: null,
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://192.168.1.50:3773/ws"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    }).pipe(Effect.flip);

    assert.equal(error.status, 401);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect("does not accept a legacy query token on a non-loopback bind", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(
        new AuthError({
          message: "Authentication required.",
          status: 401,
        }),
      ),
    );

    const error = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "192.168.1.50", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: "remote-secret",
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://192.168.1.50:3773/ws?token=remote-secret"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    }).pipe(Effect.flip);

    assert.equal(error.status, 401);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect("accepts an authenticated session on a non-loopback bind", () =>
  Effect.gen(function* () {
    const authenticatedSession = {
      sessionId: "remote-session" as never,
      subject: "owner-bootstrap",
      method: "browser-session-cookie" as const,
      role: "owner" as const,
    };
    const authenticateWebSocketUpgrade = vi.fn(() => Effect.succeed(authenticatedSession));

    const session = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "0.0.0.0", authToken: "remote-secret", publicUrl: undefined },
      legacyToken: "remote-secret",
      request: {
        headers: {},
        cookies: { "synara-session": "paired-session-credential" },
        url: new URL("http://192.168.1.50:3773/ws?token=remote-secret"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    });

    assert.equal(session, authenticatedSession);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
  }),
);

it.effect("preserves the legacy query token for loopback desktop sessions", () =>
  Effect.gen(function* () {
    const authenticateWebSocketUpgrade = vi.fn(() =>
      Effect.fail(new AuthError({ message: "Unexpected authentication call.", status: 500 })),
    );

    const session = yield* authenticateRpcWebSocketUpgrade({
      config: { host: "127.0.0.1", authToken: "desktop-secret", publicUrl: undefined },
      legacyToken: "desktop-secret",
      request: {
        headers: {},
        cookies: {},
        url: new URL("http://127.0.0.1:3773/ws?token=desktop-secret"),
      },
      serverAuth: { authenticateWebSocketUpgrade },
    });

    assert.equal(session, null);
    assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 0);
  }),
);

it.effect(
  "disables the legacy loopback query token when an HTTPS public origin is configured",
  () =>
    Effect.gen(function* () {
      const authenticatedSession = {
        sessionId: "proxy-session" as never,
        subject: "owner-bootstrap",
        method: "browser-session-cookie" as const,
        role: "owner" as const,
      };
      const authenticateWebSocketUpgrade = vi.fn(() => Effect.succeed(authenticatedSession));

      const session = yield* authenticateRpcWebSocketUpgrade({
        config: {
          host: "127.0.0.1",
          authToken: "proxy-secret",
          publicUrl: new URL("https://synara.example.test/"),
        },
        legacyToken: "proxy-secret",
        request: {
          headers: {},
          cookies: { "synara-session": "paired-session-credential" },
          url: new URL("http://127.0.0.1:3773/ws?token=proxy-secret"),
        },
        serverAuth: { authenticateWebSocketUpgrade },
      });

      assert.equal(session, authenticatedSession);
      assert.equal(authenticateWebSocketUpgrade.mock.calls.length, 1);
    }),
);
