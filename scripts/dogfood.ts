// FILE: dogfood.ts
// Purpose: Thin entry point for the personal Synara Dogfood managed build.
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

export {
  managedBuildCloneArgs as dogfoodCloneArgs,
  managedBuildStartArgs as dogfoodStartArgs,
  parseManagedBuildArgs as parseDogfoodArgs,
  resolveManagedBuildPaths as resolveDogfoodPaths,
  resolveManagedBuildRef as resolveDogfoodRef,
};
