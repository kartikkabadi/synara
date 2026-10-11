import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  RemoteAgentAttachInput,
  RemoteAgentAttachOutput,
  RemoteAgentRpcResponse,
  RemoteAgentConnectionStatusChanged,
  RemoteAgentEventEnvelope,
  RemoteAgentStatusOutput,
} from "./remoteAgent";

const invalidCursors = [-1, 0.5, NaN, Infinity, -Infinity];

describe("remote-agent replay boundaries", () => {
  it("accepts the initial cursor and rejects malformed attach/status cursors", () => {
    const attach = Schema.decodeUnknownSync(RemoteAgentAttachInput);
    expect(attach({ threadId: "thread", lastSeq: 0 }).lastSeq).toBe(0);
    for (const value of invalidCursors) {
      expect(() => attach({ threadId: "thread", lastSeq: value })).toThrow();
      expect(
        Schema.is(RemoteAgentStatusOutput)({
          threads: [{ threadId: "thread", seq: value, status: "running" }],
        }),
      ).toBe(false);
    }
    expect(() => attach(JSON.parse('{"threadId":"thread","lastSeq":1e309}'))).toThrow();
  });

  it("rejects invalid journal sequences and connection retry counters", () => {
    const connection = {
      _tag: "RemoteAgentConnectionStatusChanged",
      threadId: "thread",
      environmentId: "environment",
      status: "connected",
      retryCount: 0,
      lastSeq: 0,
    };
    expect(Schema.is(RemoteAgentConnectionStatusChanged)(connection)).toBe(true);
    expect(
      Schema.is(RemoteAgentEventEnvelope)({
        threadId: "thread",
        seq: 1,
        kind: "stdout",
        data: "YQ==",
      }),
    ).toBe(true);
    for (const value of invalidCursors) {
      expect(
        Schema.is(RemoteAgentEventEnvelope)({
          threadId: "thread",
          seq: value,
          kind: "stdout",
          data: "YQ==",
        }),
      ).toBe(false);
      expect(Schema.is(RemoteAgentConnectionStatusChanged)({ ...connection, lastSeq: value })).toBe(
        false,
      );
      expect(
        Schema.is(RemoteAgentConnectionStatusChanged)({ ...connection, retryCount: value }),
      ).toBe(false);
    }
  });
});

it("rejects malformed remote response envelopes and invalid attach cursors", () => {
  for (const value of [
    null,
    [],
    1,
    "text",
    { jsonrpc: "1.0", id: 1, result: {} },
    { jsonrpc: "2.0", id: 1, error: null },
  ]) {
    expect(() => Schema.decodeUnknownSync(RemoteAgentRpcResponse)(value)).toThrow();
  }
  expect(
    Schema.decodeUnknownSync(RemoteAgentRpcResponse)({ jsonrpc: "2.0", id: 1, result: null }),
  ).toMatchObject({ id: 1, result: null });
  for (const lastSeq of [-1, 0.5, NaN, Infinity]) {
    expect(() =>
      Schema.decodeUnknownSync(RemoteAgentAttachOutput)({ status: "running", lastSeq }),
    ).toThrow();
  }
  expect(() =>
    Schema.decodeUnknownSync(RemoteAgentAttachOutput)({ status: "ready", lastSeq: 0 }),
  ).toThrow();
});
