// FILE: promptAttachments.test.ts
// Purpose: Provider prompt attachment utility tests
// Layer: Provider adapter utility tests
// Depends on: promptAttachments helper and shared chat attachment contracts.

import { MessageId, type ChatAttachment, type ChatImageAttachment } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { ProviderAdapterRequestError } from "./Errors.ts";
import {
  filterProviderPromptImageAttachments,
  loadProviderPromptImageBlocks,
} from "./promptAttachments.ts";

describe("filterProviderPromptImageAttachments", () => {
  it("keeps images while dropping assistant selections from provider-native prompts", () => {
    const imageAttachment = {
      type: "image",
      id: "thread-1-image-1",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 128,
    } satisfies ChatAttachment;
    const selectionAttachment = {
      type: "assistant-selection",
      id: "thread-1-selection-1",
      assistantMessageId: MessageId.makeUnsafe("assistant-message-1"),
      text: "Selected assistant text is already serialized into the prompt body.",
    } satisfies ChatAttachment;

    expect(filterProviderPromptImageAttachments([selectionAttachment, imageAttachment])).toEqual([
      imageAttachment,
    ]);
  });
});

describe("loadProviderPromptImageBlocks", () => {
  const imageAttachment = {
    type: "image",
    id: "thread-1-image-1",
    name: "screen.png",
    mimeType: "image/png",
    sizeBytes: 128,
  } satisfies ChatImageAttachment;

  const makeInput = (
    readFile: (path: string) => Effect.Effect<Uint8Array, unknown>,
  ) => ({
    attachments: [imageAttachment],
    attachmentsDir: "/tmp/attachments",
    provider: "devin" as const,
    method: "session/prompt",
    readFile,
  });

  it("encodes image bytes as base64 data blocks", async () => {
    const bytes = new TextEncoder().encode("fake-image-bytes");
    const result = await Effect.runPromise(
      loadProviderPromptImageBlocks(makeInput(() => Effect.succeed(bytes))),
    );
    expect(result).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: Buffer.from(bytes).toString("base64"),
      },
    ]);
  });

  it("returns a typed error when the image file cannot be read", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        loadProviderPromptImageBlocks(
          makeInput(() => Effect.fail(new Error("ENOENT: file not found"))),
        ),
      ),
    );
    expect(error).toBeInstanceOf(ProviderAdapterRequestError);
    expect((error as ProviderAdapterRequestError).message).toContain("ENOENT");
  });

  it("returns a typed error for an attachment with a traversal-resolved path", async () => {
    const result = await Effect.runPromise(
      Effect.flip(
        loadProviderPromptImageBlocks({
          ...makeInput(() => Effect.succeed(new Uint8Array(0))),
          attachments: [
            {
              type: "image",
              id: "../etc/passwd",
              name: "traversal.png",
              mimeType: "image/png",
              sizeBytes: 0,
            },
          ],
        }),
      ),
    );
    expect(result).toBeInstanceOf(ProviderAdapterRequestError);
    expect((result as ProviderAdapterRequestError).message).toContain("Invalid attachment id");
  });
});
