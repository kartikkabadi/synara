// FILE: desktopUserDataProfile.ts
// Purpose: Resolves Synara's Electron userData paths and completes bridge profile repair.

import * as ChildProcess from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const BRIDGE_PROFILE_MANIFEST_FILE_NAME = "synara-profile-seed.json";
const CANONICAL_BROWSER_PARTITION_NAME = "synara-browser";
const BROWSER_PARTITION_SEED_ENTRY_GROUPS = [
  ["Cookies", "Cookies-journal", "Cookies-wal", "Cookies-shm"],
  ["Local Storage"],
  ["IndexedDB"],
  ["Session Storage"],
  ["WebStorage"],
  ["Service Worker"],
  ["Preferences"],
  ["Network Persistent State"],
  ["TransportSecurity"],
  ["Trust Tokens", "Trust Tokens-journal", "Trust Tokens-wal", "Trust Tokens-shm"],
  ["SharedStorage", "SharedStorage-journal", "SharedStorage-wal", "SharedStorage-shm"],
  ["shared_proto_db"],
] as const;
const BROWSER_PARTITION_SEED_ENTRY_NAMES = BROWSER_PARTITION_SEED_ENTRY_GROUPS.flat();

export interface BrowserProfileBridgeRepairResult {
  readonly status: "repaired" | "not-needed" | "bridge-unavailable" | "repair-failed";
  readonly sourcePath: string | null;
  readonly targetPath: string;
  readonly copiedEntries: readonly string[];
  readonly error?: unknown;
}

interface BridgeProfileManifest {
  readonly sourcePath: string;
  readonly sourceBrowserPartitionName?: string | undefined;
  readonly sourceScheme?: string | undefined;
  readonly targetScheme?: string | undefined;
}

interface RunCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

export function resolveDesktopAppDataBase(input?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): string {
  const platform = input?.platform ?? process.platform;
  const env = input?.env ?? process.env;
  const homeDir = input?.homeDir ?? OS.homedir();

  if (platform === "win32") {
    return env.APPDATA || Path.join(homeDir, "AppData", "Roaming");
  }
  if (platform === "darwin") {
    return Path.join(homeDir, "Library", "Application Support");
  }
  return env.XDG_CONFIG_HOME || Path.join(homeDir, ".config");
}

export function resolveDesktopUserDataPath(input: {
  readonly appDataBase: string;
  readonly userDataDirectoryName: string;
}): string {
  return Path.join(input.appDataBase, input.userDataDirectoryName);
}

function runCommand(command: string, args: ReadonlyArray<string>): RunCommandResult {
  const result = ChildProcess.spawnSync(command, [...args], { encoding: "utf8" });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? null,
  };
}

function readBridgeProfileManifest(targetPath: string): BridgeProfileManifest | null {
  const manifestPath = Path.join(targetPath, BRIDGE_PROFILE_MANIFEST_FILE_NAME);
  if (!FS.existsSync(manifestPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(FS.readFileSync(manifestPath, "utf8")) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.sourcePath !== "string" || !Path.isAbsolute(record.sourcePath)) {
    return null;
  }

  const sourcePath = Path.resolve(record.sourcePath);
  const resolvedTargetPath = Path.resolve(targetPath);
  if (
    sourcePath === resolvedTargetPath ||
    Path.dirname(sourcePath) !== Path.dirname(resolvedTargetPath)
  ) {
    return null;
  }

  const sourceBrowserPartitionName =
    record.sourceBrowserPartitionName === undefined
      ? undefined
      : String(record.sourceBrowserPartitionName);
  const sourceScheme = record.sourceScheme === undefined ? undefined : String(record.sourceScheme);
  const targetScheme = record.targetScheme === undefined ? undefined : String(record.targetScheme);
  if ((sourceScheme === undefined) !== (targetScheme === undefined)) {
    return null;
  }

  return { sourcePath, sourceBrowserPartitionName, sourceScheme, targetScheme };
}

function findBridgeBrowserPartitionPaths(
  sourceProfilePath: string,
  explicitPartitionName?: string | undefined,
): string[] {
  const partitionsPath = Path.join(sourceProfilePath, "Partitions");
  if (!FS.existsSync(partitionsPath)) return [];

  if (explicitPartitionName !== undefined) {
    const explicitPath = Path.join(partitionsPath, explicitPartitionName);
    if (
      FS.existsSync(explicitPath) &&
      BROWSER_PARTITION_SEED_ENTRY_NAMES.some((entryName) =>
        FS.existsSync(Path.join(explicitPath, entryName)),
      )
    ) {
      return [explicitPath];
    }
    return [];
  }

  return FS.readdirSync(partitionsPath, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.endsWith("-browser") &&
        entry.name !== CANONICAL_BROWSER_PARTITION_NAME,
    )
    .map((entry) => Path.join(partitionsPath, entry.name))
    .filter((partitionPath) =>
      BROWSER_PARTITION_SEED_ENTRY_NAMES.some((entryName) =>
        FS.existsSync(Path.join(partitionPath, entryName)),
      ),
    )
    .toSorted((left, right) => FS.statSync(right).mtimeMs - FS.statSync(left).mtimeMs);
}

function readFileUtf8(filePath: string): string | null {
  try {
    return FS.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function replaceOriginInTextFile(
  filePath: string,
  sourceScheme: string,
  targetScheme: string,
): boolean {
  const content = readFileUtf8(filePath);
  if (content === null) return false;
  if (!content.includes(sourceScheme)) return false;
  FS.writeFileSync(filePath, content.split(sourceScheme).join(targetScheme));
  return true;
}

function rewritePlistOrigin(filePath: string, sourceScheme: string, targetScheme: string): boolean {
  if (!FS.existsSync(filePath)) return false;
  const tempXmlPath = `${filePath}.synara-bridge-xml`;
  try {
    const convertOut = runCommand("plutil", ["-convert", "xml1", "-o", tempXmlPath, filePath]);
    if (convertOut.status !== 0) return false;
    const xmlContent = readFileUtf8(tempXmlPath);
    if (xmlContent === null || !xmlContent.includes(sourceScheme)) {
      FS.rmSync(tempXmlPath, { force: true });
      return false;
    }
    FS.writeFileSync(tempXmlPath, xmlContent.split(sourceScheme).join(targetScheme));
    const convertBack = runCommand("plutil", ["-convert", "binary1", "-o", filePath, tempXmlPath]);
    FS.rmSync(tempXmlPath, { force: true });
    return convertBack.status === 0;
  } catch {
    FS.rmSync(tempXmlPath, { force: true });
    return false;
  }
}

function rewriteTopLevelScheme(
  targetPath: string,
  sourceScheme: string,
  targetScheme: string,
): void {
  const networkStatePath = Path.join(targetPath, "Network Persistent State");
  if (FS.existsSync(networkStatePath)) {
    replaceOriginInTextFile(networkStatePath, sourceScheme, targetScheme);
  }
  const preferencesPath = Path.join(targetPath, "Preferences");
  if (FS.existsSync(preferencesPath)) {
    rewritePlistOrigin(preferencesPath, sourceScheme, targetScheme);
  }
  const transportSecurityPath = Path.join(targetPath, "TransportSecurity");
  if (FS.existsSync(transportSecurityPath)) {
    rewritePlistOrigin(transportSecurityPath, sourceScheme, targetScheme);
  }
}

/**
 * Finishes any browser-partition copy described by the compatibility bridge.
 *
 * The bridge manifest identifies the exact sibling profile that supplied the Synara profile.
 * Discovering its `*-browser` partition from that trusted path avoids shipping predecessor names
 * while still repairing cookies or storage entries that were absent during the first bridge run.
 */
export function repairBrowserProfileFromBridgeManifest(
  targetPath: string,
): BrowserProfileBridgeRepairResult {
  let sourcePath: string | null = null;
  const copiedEntries: string[] = [];
  try {
    const manifest = readBridgeProfileManifest(targetPath);
    if (!manifest || !FS.existsSync(manifest.sourcePath)) {
      return {
        status: "bridge-unavailable",
        sourcePath: manifest?.sourcePath ?? null,
        targetPath,
        copiedEntries: [],
      };
    }
    sourcePath = manifest.sourcePath;

    const sourcePartitionPath = findBridgeBrowserPartitionPaths(
      sourcePath,
      manifest.sourceBrowserPartitionName,
    )[0];
    if (!sourcePartitionPath) {
      return {
        status: "not-needed",
        sourcePath,
        targetPath,
        copiedEntries: [],
      };
    }

    const targetPartitionPath = Path.join(
      targetPath,
      "Partitions",
      CANONICAL_BROWSER_PARTITION_NAME,
    );
    for (const entryGroup of BROWSER_PARTITION_SEED_ENTRY_GROUPS) {
      const baseEntryName = entryGroup[0];
      if (!FS.existsSync(Path.join(sourcePartitionPath, baseEntryName))) continue;
      if (FS.existsSync(Path.join(targetPartitionPath, baseEntryName))) continue;

      const sourceEntryNames = entryGroup.filter((entryName) =>
        FS.existsSync(Path.join(sourcePartitionPath, entryName)),
      );
      FS.mkdirSync(targetPartitionPath, { recursive: true });
      const stagedGroupPath = FS.mkdtempSync(Path.join(targetPartitionPath, ".synara-bridge-"));
      const stagedSourcePath = Path.join(stagedGroupPath, "source");
      const stagedTargetBackupPath = Path.join(stagedGroupPath, "target-backup");
      try {
        // Stage the whole source generation before removing orphaned target
        // sidecars, so a failed source copy leaves the target untouched.
        FS.mkdirSync(stagedSourcePath, { recursive: true });
        for (const entryName of sourceEntryNames) {
          FS.cpSync(
            Path.join(sourcePartitionPath, entryName),
            Path.join(stagedSourcePath, entryName),
            {
              recursive: true,
              errorOnExist: true,
              force: false,
            },
          );
        }

        // Another startup may have completed the repair while this group was
        // staged. Preserve its database and leave its sidecars untouched.
        if (FS.existsSync(Path.join(targetPartitionPath, baseEntryName))) continue;

        const installOrder = [
          ...sourceEntryNames.filter((entryName) => entryName !== baseEntryName),
          baseEntryName,
        ];
        const displacedTargetEntries: string[] = [];
        const installedSourceEntries: string[] = [];
        try {
          FS.mkdirSync(stagedTargetBackupPath, { recursive: true });
          for (const sidecarEntryName of entryGroup.slice(1)) {
            const targetEntryPath = Path.join(targetPartitionPath, sidecarEntryName);
            if (!FS.existsSync(targetEntryPath)) continue;
            FS.renameSync(targetEntryPath, Path.join(stagedTargetBackupPath, sidecarEntryName));
            displacedTargetEntries.push(sidecarEntryName);
          }
          for (const entryName of installOrder) {
            FS.renameSync(
              Path.join(stagedSourcePath, entryName),
              Path.join(targetPartitionPath, entryName),
            );
            installedSourceEntries.push(entryName);
          }
        } catch (installError) {
          const rollbackErrors: unknown[] = [];
          for (const entryName of installedSourceEntries.toReversed()) {
            try {
              FS.rmSync(Path.join(targetPartitionPath, entryName), {
                recursive: true,
                force: true,
              });
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
          for (const entryName of displacedTargetEntries) {
            try {
              FS.renameSync(
                Path.join(stagedTargetBackupPath, entryName),
                Path.join(targetPartitionPath, entryName),
              );
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError);
            }
          }
          if (rollbackErrors.length > 0) {
            const aggregateError = new AggregateError(
              [installError, ...rollbackErrors],
              "Browser profile bridge repair and rollback failed",
            );
            (aggregateError as Error).cause = installError;
            throw aggregateError;
          }
          throw installError;
        }
        copiedEntries.push(...sourceEntryNames);
      } finally {
        FS.rmSync(stagedGroupPath, { recursive: true, force: true });
      }
    }

    if (manifest.sourceScheme !== undefined && manifest.targetScheme !== undefined) {
      rewriteTopLevelScheme(targetPath, manifest.sourceScheme, manifest.targetScheme);
    }

    return {
      status: copiedEntries.length > 0 ? "repaired" : "not-needed",
      sourcePath,
      targetPath,
      copiedEntries,
    };
  } catch (error) {
    return {
      status: "repair-failed",
      sourcePath,
      targetPath,
      copiedEntries,
      error,
    };
  }
}
