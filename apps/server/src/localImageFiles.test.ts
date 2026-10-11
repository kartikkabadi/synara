import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, vi } from "vitest";

import { resolveCodexHomeOverlayAccountSegment } from "./codexHomePaths.ts";
import {
  createLocalPreviewGrant,
  resolveAllowedLocalPreviewFile,
  resolveLocalPreviewGrantRealPath,
} from "./localImageFiles.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveAllowedLocalPreviewFile", () => {
  it("does not fall back to ambient Codex homes when the allowlist is intentionally empty", async () => {
    const fakeRoot = path.join(
      process.cwd(),
      `.test-codex-empty-allowlist-${process.pid}-${Date.now()}`,
    );
    const codexHome = path.join(fakeRoot, ".codex-disabled");
    const imageDir = path.join(codexHome, "generated_images", "provider-thread");
    const imagePath = path.join(imageDir, "call.png");
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
        codexHomePaths: [],
      });

      assert.equal(result, null);
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("allows images written to the SYNARA_HOME codex-home-overlay generated_images root", async () => {
    // Codex app-server is launched with CODEX_HOME pointing at a Synara overlay
    // directory (see resolveSynaraCodexHomeOverlayPath). Generated images therefore
    // live under <SYNARA_HOME>/codex-home-overlay/generated_images/<thread>/<call>.png,
    // which sits outside both the user's `~/.codex` source home and any workspace
    // root. The allowlist must still serve them.
    //
    // We anchor the fake homes inside the worktree (process.cwd() resolves to
    // apps/server/ when vitest runs) so neither path falls under os.tmpdir(); that
    // way only the overlay candidate can satisfy the allowlist.
    const fakeRoot = path.join(process.cwd(), `.test-codex-overlay-${process.pid}-${Date.now()}`);
    const sourceHome = path.join(fakeRoot, "source", ".codex");
    const synaraHome = path.join(fakeRoot, "synara", "runtime");
    const overlayImageDir = path.join(
      synaraHome,
      "codex-home-overlay",
      "generated_images",
      "thread-overlay",
    );
    const imagePath = path.join(overlayImageDir, "call.png");
    mkdirSync(overlayImageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const previousSynaraHome = process.env.SYNARA_HOME;
    process.env.SYNARA_HOME = synaraHome;
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
        codexHomePath: sourceHome,
      });

      assert.equal(result?.path, realpathSync(imagePath));
    } finally {
      if (previousSynaraHome === undefined) {
        delete process.env.SYNARA_HOME;
      } else {
        process.env.SYNARA_HOME = previousSynaraHome;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("rejects generated images from sibling Codex account overlays", async () => {
    const fakeRoot = path.join(
      process.cwd(),
      `.test-codex-account-overlay-${process.pid}-${Date.now()}`,
    );
    const sourceHome = path.join(fakeRoot, "source", ".codex");
    const synaraHome = path.join(fakeRoot, "synara", "runtime");
    const siblingImageDir = path.join(
      synaraHome,
      "codex-home-overlay",
      "accounts",
      "work-account",
      "generated_images",
      "thread-work",
    );
    const imagePath = path.join(siblingImageDir, "call.png");
    mkdirSync(siblingImageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const previousSynaraHome = process.env.SYNARA_HOME;
    process.env.SYNARA_HOME = synaraHome;
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
        codexHomePath: sourceHome,
      });

      assert.equal(result, null);
    } finally {
      if (previousSynaraHome === undefined) {
        delete process.env.SYNARA_HOME;
      } else {
        process.env.SYNARA_HOME = previousSynaraHome;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("rejects generated_images roots that symlink outside the configured Codex home", async () => {
    if (process.platform === "win32") return;
    const fakeRoot = path.join(
      process.cwd(),
      `.test-codex-symlinked-images-${process.pid}-${Date.now()}`,
    );
    tempDirs.push(fakeRoot);
    const codexHome = path.join(fakeRoot, "codex-home");
    const outsideRoot = path.join(fakeRoot, "outside");
    const imagePath = path.join(outsideRoot, "thread", "call.png");
    mkdirSync(path.dirname(imagePath), { recursive: true });
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    symlinkSync(outsideRoot, path.join(codexHome, "generated_images"), "dir");

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: imagePath,
      cwd: null,
      codexHomePaths: [codexHome],
    });

    assert.equal(result, null);
  });

  it("allows generated images from the configured Codex account overlay", async () => {
    const fakeRoot = path.join(
      process.cwd(),
      `.test-codex-configured-account-overlay-${process.pid}-${Date.now()}`,
    );
    const sourceHome = path.join(fakeRoot, "source", ".codex-work");
    const shadowHome = path.join(fakeRoot, "shadow", ".codex-work-auth");
    const synaraHome = path.join(fakeRoot, "synara", "runtime");
    const accountSegment = resolveCodexHomeOverlayAccountSegment({
      homePath: sourceHome,
      shadowHomePath: shadowHome,
      accountId: "work",
    });
    assert.ok(accountSegment, "expected an account overlay segment");
    const imageDir = path.join(
      synaraHome,
      "codex-home-overlay",
      "accounts",
      accountSegment,
      "generated_images",
      "thread-work",
    );
    const imagePath = path.join(imageDir, "call.png");
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const previousSynaraHome = process.env.SYNARA_HOME;
    process.env.SYNARA_HOME = synaraHome;
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: imagePath,
        cwd: null,
        codexHomePaths: [
          {
            homePath: sourceHome,
            shadowHomePath: shadowHome,
            accountId: "work",
          },
        ],
      });

      assert.equal(result?.path, realpathSync(imagePath));
    } finally {
      if (previousSynaraHome === undefined) {
        delete process.env.SYNARA_HOME;
      } else {
        process.env.SYNARA_HOME = previousSynaraHome;
      }
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });

  it("allows PDFs inside dot-prefixed workspace directories", async () => {
    const workspace = makeTempDir("synara-pdf-workspace-");
    writeFileSync(path.join(workspace, ".git"), "gitdir: .git");
    const pdfPath = path.join(workspace, "..assets", "spec.pdf");
    mkdirSync(path.dirname(pdfPath), { recursive: true });
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: pdfPath,
      cwd: workspace,
    });

    assert.equal(result?.path, realpathSync(pdfPath));
    assert.equal(result?.fileName, "spec.pdf");
    assert.equal(result?.sizeBytes, 8);
  });

  it("allows PDFs inside a per-thread scratch workspace without a cwd", async () => {
    // Sessions that start before a project workspace exists run in
    // <tmpdir>/synara-codex-workspaces/<threadId>; files agents create there
    // are workspace-equivalent, so documents must be servable from that root.
    const scratchRoot = path.join(os.tmpdir(), "synara-codex-workspaces");
    const threadDir = path.join(scratchRoot, `test-thread-${process.pid}-${Date.now()}`);
    const pdfPath = path.join(threadDir, "viewer-test.pdf");
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));
    try {
      const result = await resolveAllowedLocalPreviewFile({
        requestedPath: pdfPath,
        cwd: null,
      });

      assert.equal(result?.path, realpathSync(pdfPath));
      assert.equal(result?.fileName, "viewer-test.pdf");
      assert.equal(result?.sizeBytes, 8);
    } finally {
      // Remove only the per-thread dir — the shared scratch root may belong
      // to a live server.
      rmSync(threadDir, { recursive: true, force: true });
    }
  });

  it("allows PDFs inside the configured private scratch root without a cwd", async () => {
    const privateTempRoot = makeTempDir("synara-private-scratch-");
    const scratchRoot = path.join(privateTempRoot, "synara-codex-workspaces");
    const threadDir = path.join(scratchRoot, "private-thread");
    const pdfPath = path.join(threadDir, "private-scratch.pdf");
    mkdirSync(threadDir, { recursive: true });
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: pdfPath,
      cwd: null,
      scratchWorkspacesRoot: scratchRoot,
    });

    assert.equal(result?.path, realpathSync(pdfPath));
    assert.equal(result?.fileName, "private-scratch.pdf");
  });

  it("rejects PDFs outside the workspace even under the temp-dir image roots", async () => {
    // Temp/generated-image roots exist for agent-produced images in chat
    // markdown; documents must only ever be served from the workspace.
    const tempDir = makeTempDir("synara-pdf-outside-");
    const pdfPath = path.join(tempDir, "leak.pdf");
    writeFileSync(pdfPath, Buffer.from("%PDF-1.4"));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: pdfPath,
      cwd: null,
    });

    assert.equal(result, null);
  });

  it("still allows images under the temp-dir roots without a workspace", async () => {
    const tempDir = makeTempDir("synara-image-tmp-root-");
    const imagePath = path.join(tempDir, "clip.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: imagePath,
      cwd: null,
    });

    assert.equal(result?.path, realpathSync(imagePath));
  });

  it("rejects unsupported paths", async () => {
    const result = await resolveAllowedLocalPreviewFile({
      requestedPath: "/etc/hosts",
      cwd: null,
    });

    assert.equal(result, null);
  });
});

describe("createLocalPreviewGrant", () => {
  it("canonicalizes both the workspace root and in-root symlinks", async () => {
    const root = makeTempDir("synara-preview-grant-");
    const workspace = path.join(root, "workspace");
    const alias = path.join(root, "alias");
    mkdirSync(workspace);
    symlinkSync(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    const file = path.join(workspace, "report.txt");
    writeFileSync(file, "report");
    const grant = await createLocalPreviewGrant({
      requestedPath: path.join(alias, "report.txt"),
      allowedRoots: [alias, path.join(root, "missing")],
    });
    assert.equal(resolveLocalPreviewGrantRealPath({ token: grant.grant }), realpathSync(file));
  });

  it("rejects outside roots, traversal, prefix siblings, symlink escapes and implicit temp roots", async () => {
    const root = makeTempDir("synara-preview-grant-boundary-");
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "workspace-other");
    mkdirSync(workspace);
    mkdirSync(outside);
    const secret = path.join(outside, "report.pdf");
    writeFileSync(secret, "%PDF-1.7");
    symlinkSync(
      outside,
      path.join(workspace, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const requestedPath of [
      secret,
      `${workspace}/../workspace-other/report.pdf`,
      path.join(workspace, "escape", "report.pdf"),
    ]) {
      await assert.rejects(
        createLocalPreviewGrant({ requestedPath, allowedRoots: [workspace] }),
        /outside the allowed workspace roots/,
      );
    }
    await assert.rejects(
      createLocalPreviewGrant({ requestedPath: secret, allowedRoots: [] }),
      /outside the allowed workspace roots/,
    );
  });

  it("allows only canonical image captures under Desktop and Downloads", async () => {
    const home = makeTempDir("synara-preview-capture-");
    const sibling = path.join(home, "Desktop-other");
    mkdirSync(sibling);
    writeFileSync(path.join(sibling, "secret.png"), "secret");
    for (const directory of ["Desktop", "Downloads"]) {
      const captureRoot = path.join(home, directory);
      mkdirSync(captureRoot);
      const image = path.join(captureRoot, "simulator.png");
      writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const grant = await createLocalPreviewGrant({
        requestedPath: image,
        allowedRoots: [],
        captureHome: home,
      });
      assert.equal(resolveLocalPreviewGrantRealPath({ token: grant.grant }), realpathSync(image));
      for (const extension of ["txt", "pdf"]) {
        const document = path.join(captureRoot, `report.${extension}`);
        writeFileSync(document, "document");
        await assert.rejects(
          createLocalPreviewGrant({ requestedPath: document, allowedRoots: [], captureHome: home }),
          /outside the allowed workspace roots/,
        );
      }
      const escape = path.join(captureRoot, "escape");
      symlinkSync(sibling, escape, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(
        createLocalPreviewGrant({
          requestedPath: path.join(escape, "secret.png"),
          allowedRoots: [],
          captureHome: home,
        }),
        /outside the allowed workspace roots/,
      );
    }
    await assert.rejects(
      createLocalPreviewGrant({
        requestedPath: path.join(sibling, "secret.png"),
        allowedRoots: [],
        captureHome: home,
      }),
      /outside the allowed workspace roots/,
    );
  });

  it("does not allow a capture-folder symlink to authorize an unrelated root", async () => {
    const home = makeTempDir("synara-preview-capture-home-");
    const outside = makeTempDir("synara-preview-capture-outside-");
    const image = path.join(outside, "secret.png");
    writeFileSync(image, "image");
    symlinkSync(
      outside,
      path.join(home, "Desktop"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      createLocalPreviewGrant({
        requestedPath: path.join(home, "Desktop", "secret.png"),
        allowedRoots: [],
        captureHome: home,
      }),
      /outside the allowed workspace roots/,
    );
  });

  it("grants configured generated images without granting the rest of their data home", async () => {
    const root = makeTempDir("synara-preview-generated-grants-");
    const sourceHome = path.join(root, "source-home");
    const runtimeHome = path.join(root, "instance-state");
    const overlay = path.join(runtimeHome, "codex-home-overlay");
    const generatedRoot = path.join(overlay, "generated_images");
    const codexHomePaths = [{ homePath: sourceHome, environment: { SYNARA_HOME: runtimeHome } }];
    mkdirSync(generatedRoot, { recursive: true });
    mkdirSync(sourceHome);
    const image = path.join(generatedRoot, "output.png");
    writeFileSync(image, "image");
    const grant = await createLocalPreviewGrant({
      requestedPath: image,
      allowedRoots: [],
      codexHomePaths,
    });
    assert.equal(resolveLocalPreviewGrantRealPath({ token: grant.grant }), realpathSync(image));
    await assert.rejects(
      createLocalPreviewGrant({ requestedPath: image, allowedRoots: [], codexHomePaths: [] }),
      /outside the allowed workspace roots/,
    );
    const sibling = path.join(overlay, "private.png");
    const pdf = path.join(generatedRoot, "private.pdf");
    writeFileSync(sibling, "private");
    writeFileSync(pdf, "document");
    for (const requestedPath of [sibling, pdf]) {
      await assert.rejects(
        createLocalPreviewGrant({ requestedPath, allowedRoots: [], codexHomePaths }),
        /outside the allowed workspace roots/,
      );
    }
    const outside = path.join(root, "unrelated");
    mkdirSync(outside);
    const outsideImage = path.join(outside, "private.png");
    writeFileSync(outsideImage, "private");
    symlinkSync(
      outside,
      path.join(sourceHome, "generated_images"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      createLocalPreviewGrant({ requestedPath: outsideImage, allowedRoots: [], codexHomePaths }),
      /outside the allowed workspace roots/,
    );
  });

  it("rejects forged and expired tokens", async () => {
    const root = makeTempDir("synara-preview-grant-expiry-");
    const file = path.join(root, "report.txt");
    writeFileSync(file, "report");
    const grant = await createLocalPreviewGrant({ requestedPath: file, allowedRoots: [root] });
    assert.equal(resolveLocalPreviewGrantRealPath({ token: "forged-preview-token" }), null);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(grant.expiresAt));
    try {
      assert.equal(resolveLocalPreviewGrantRealPath({ token: grant.grant }), null);
    } finally {
      clock.mockRestore();
    }
  });
});
