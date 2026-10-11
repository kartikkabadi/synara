import { describe, expect, it } from "vitest";
import { sshProcessEnv } from "./sshProcessEnv";

describe("sshProcessEnv", () => {
  it("retains SSH client essentials without exposing provider secrets to SendEnv", () => {
    expect(
      sshProcessEnv({
        PATH: "/bin",
        HOME: "/home/test",
        SSH_AUTH_SOCK: "/agent",
        LANG: "C",
        OPENAI_API_KEY: "secret",
        SYNARA_AUTH_TOKEN: "secret",
        CODEX_HOME: "/private/codex",
        CUSTOM_TOKEN: "secret",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/home/test", SSH_AUTH_SOCK: "/agent", LANG: "C" });
  });
});
