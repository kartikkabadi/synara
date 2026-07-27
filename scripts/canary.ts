// FILE: canary.ts
// Purpose: Thin entry point for the upstream Synara Canary managed build.
// Layer: Local developer tooling

import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import {
  managedBuildCloneArgs,
  managedBuildStartArgs,
  parseManagedBuildArgs,
  resolveManagedBuildPaths,
  resolveManagedBuildRef,
  runManagedBuildCommand,
} from "./managedBuild";

export const canaryConfig = {
  name: "canary",
  displayName: "Synara Canary",
  flavor: "canary",
  defaultRef: "upstream/main",
  homeDirName: ".synara-canary",
  cacheSourceDirName: "synara-canary",
  homeEnvVar: "SYNARA_CANARY_HOME",
  sourceEnvVar: "SYNARA_CANARY_SOURCE",
  stateFileName: "canary-state.json",
  pidFileName: "canary.pid",
  logFileName: "canary.log",
} as const;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const isMain = process.argv[1] !== undefined && Path.resolve(process.argv[1]) === SCRIPT_PATH;

if (isMain) {
  try {
    runManagedBuildCommand(canaryConfig, parseManagedBuildArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export {
  managedBuildCloneArgs as canaryCloneArgs,
  managedBuildStartArgs as canaryStartArgs,
  parseManagedBuildArgs as parseCanaryArgs,
  resolveManagedBuildPaths as resolveCanaryPaths,
  resolveManagedBuildRef as resolveCanaryRef,
};
