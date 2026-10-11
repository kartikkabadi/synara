import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { resolveLocalPreviewGrantRealPath } from "./localImageFiles";
import { resolveScratchWorkspacesRoot } from "./scratchWorkspaces";
import { makeLocalPreviewGrantHandler } from "./wsRpc";

const configFor = (root: string) => ({
  homeDir: path.join(root, "home"),
  worktreesDir: path.join(root, "state", "worktrees"),
  chatWorkspaceRoot: path.join(root, "home", "Documents", "Synara"),
  studioWorkspaceRoot: path.join(root, "studio"),
  groupsWorkspaceRoot: path.join(root, "groups"),
});

describe("local preview grant RPC handler", () => {
  it("uses registered folders, task directories, managed roots, and private scratch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-preview-roots-"));
    try {
      const config = configFor(root);
      const project = path.join(root, "project");
      const extra = path.join(root, "additional-folder");
      const worktree = path.join(root, "imported-worktree");
      const associated = path.join(root, "associated-worktree");
      const workingDirectory = path.join(root, "working-directory");
      const handler = makeLocalPreviewGrantHandler({
        config,
        getShellSnapshot: () =>
          Effect.succeed({
            projects: [{ workspaceRoot: project, additionalFolders: [extra] }],
            threads: [
              { worktreePath: worktree, associatedWorktreePath: associated, workingDirectory },
            ],
          }),
      });
      const roots = [
        project,
        extra,
        worktree,
        associated,
        workingDirectory,
        config.worktreesDir,
        config.chatWorkspaceRoot,
        config.studioWorkspaceRoot,
        config.groupsWorkspaceRoot,
        resolveScratchWorkspacesRoot({ homeDirectory: config.homeDir }),
      ];
      for (const allowedRoot of roots) {
        const file = path.join(allowedRoot, "output.txt");
        await fs.mkdir(allowedRoot, { recursive: true });
        await fs.writeFile(file, "output");
        const grant = await Effect.runPromise(handler({ path: file }));
        expect(resolveLocalPreviewGrantRealPath({ token: grant.grant })).toBe(
          await fs.realpath(file),
        );
      }
      const outside = path.join(root, "unregistered.txt");
      await fs.writeFile(outside, "outside");
      await expect(Effect.runPromise(handler({ path: outside }))).rejects.toThrow(
        "outside the allowed workspace roots",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("denies relocated text/PDF until their folder is registered and refreshes roots per request", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-preview-relocation-"));
    try {
      const config = configFor(root);
      const downloads = path.join(config.homeDir, "Downloads");
      await fs.mkdir(downloads, { recursive: true });
      let additionalFolders: string[] = [];
      const handler = makeLocalPreviewGrantHandler({
        config,
        getShellSnapshot: () =>
          Effect.succeed({
            projects: [{ workspaceRoot: config.chatWorkspaceRoot, additionalFolders }],
            threads: [],
          }),
      });
      for (const extension of ["txt", "pdf"]) {
        const file = path.join(downloads, `relocated.${extension}`);
        await fs.writeFile(file, "document");
        await expect(Effect.runPromise(handler({ path: file }))).rejects.toThrow(
          "outside the allowed workspace roots",
        );
        additionalFolders = [downloads];
        const grant = await Effect.runPromise(handler({ path: file }));
        expect(resolveLocalPreviewGrantRealPath({ token: grant.grant })).toBe(
          await fs.realpath(file),
        );
        additionalFolders = [];
        await expect(Effect.runPromise(handler({ path: file }))).rejects.toThrow(
          "outside the allowed workspace roots",
        );
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("uses the current server-generated image account scope for file-panel grants", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-preview-account-"));
    try {
      const config = configFor(root);
      const runtimeHome = path.join(root, "instance-state");
      const image = path.join(runtimeHome, "codex-home-overlay", "generated_images", "output.png");
      await fs.mkdir(path.dirname(image), { recursive: true });
      await fs.writeFile(image, "image");
      let enabled = true;
      const handler = makeLocalPreviewGrantHandler({
        config,
        getShellSnapshot: () => Effect.succeed({ projects: [], threads: [] }),
        codexHomePaths: Effect.sync(() =>
          enabled
            ? [
                {
                  homePath: path.join(root, "source-home"),
                  environment: { SYNARA_HOME: runtimeHome },
                },
              ]
            : [],
        ),
      });
      const grant = await Effect.runPromise(handler({ path: image }));
      expect(resolveLocalPreviewGrantRealPath({ token: grant.grant })).toBe(
        await fs.realpath(image),
      );
      enabled = false;
      await expect(Effect.runPromise(handler({ path: image }))).rejects.toThrow(
        "outside the allowed workspace roots",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the server cannot read workspace ownership", async () => {
    const handler = makeLocalPreviewGrantHandler({
      config: configFor("/unused"),
      getShellSnapshot: () => Effect.fail(new Error("snapshot unavailable")),
    });
    await expect(Effect.runPromise(handler({ path: "/unused/output.png" }))).rejects.toThrow(
      "snapshot unavailable",
    );
  });
});
