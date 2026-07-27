// FILE: dogfood.ts
// Purpose: Thin entry point for the personal Synara Dogfood managed build.
// Layer: Local developer tooling

import * as OS from "node:os";
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
import type { ManagedBuildPaths, ParsedManagedBuildArgs } from "./managedBuild";

export const dogfoodConfig = {
  name: "dogfood",
  displayName: "Synara Dogfood",
  flavor: "dogfood",
  defaultRef: "dogfood",
  homeDirName: ".synara-dogfood",
  cacheSourceDirName: "synara-dogfood",
  homeEnvVar: "SYNARA_DOGFOOD_HOME",
  sourceEnvVar: "SYNARA_DOGFOOD_SOURCE",
  stateFileName: "dogfood-state.json",
  pidFileName: "dogfood.pid",
  logFileName: "dogfood.log",
} as const;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const isMain = process.argv[1] !== undefined && Path.resolve(process.argv[1]) === SCRIPT_PATH;

if (isMain) {
  try {
    runManagedBuildCommand(dogfoodConfig, parseManagedBuildArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export function resolveDogfoodPaths(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = OS.homedir(),
): ManagedBuildPaths {
  return resolveManagedBuildPaths(dogfoodConfig, env, homeDirectory);
}

export function resolveDogfoodRef(
  input: ParsedManagedBuildArgs,
  trackedRef: string | null,
): string {
  return resolveManagedBuildRef(input, trackedRef, dogfoodConfig.defaultRef);
}

export { managedBuildCloneArgs as dogfoodCloneArgs };
export { managedBuildStartArgs as dogfoodStartArgs };
export { parseManagedBuildArgs as parseDogfoodArgs };
