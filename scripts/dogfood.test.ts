import { describe, expect, it } from "vitest";

import {
  dogfoodCloneArgs,
  dogfoodConfig,
  dogfoodStartArgs,
  parseDogfoodArgs,
  resolveDogfoodPaths,
  resolveDogfoodRef,
} from "./dogfood";

describe("dogfood tooling", () => {
  it("keeps managed source and Dogfood data separate from Stable and Canary", () => {
    expect(resolveDogfoodPaths({}, "/Users/tester")).toEqual({
      home: "/Users/tester/.synara-dogfood",
      source: "/Users/tester/.cache/synara-dogfood/source",
      state: "/Users/tester/.synara-dogfood/dogfood-state.json",
      pid: "/Users/tester/.synara-dogfood/dogfood.pid",
      log: "/Users/tester/.synara-dogfood/dogfood.log",
    });
  });

  it("supports explicit path overrides", () => {
    expect(
      resolveDogfoodPaths(
        {
          SYNARA_DOGFOOD_HOME: "/tmp/dogfood-data",
          SYNARA_DOGFOOD_SOURCE: "/tmp/dogfood-source",
        },
        "/Users/tester",
      ),
    ).toEqual({
      home: "/tmp/dogfood-data",
      source: "/tmp/dogfood-source",
      state: "/tmp/dogfood-data/dogfood-state.json",
      pid: "/tmp/dogfood-data/dogfood.pid",
      log: "/tmp/dogfood-data/dogfood.log",
    });
  });

  it("tracks the dogfood branch by default and accepts explicit refs", () => {
    expect(parseDogfoodArgs(["update"])).toEqual({ command: "update", ref: null });
    expect(parseDogfoodArgs(["setup", "--ref", "origin/dogfood"])).toEqual({
      command: "setup",
      ref: "origin/dogfood",
    });
    expect(dogfoodConfig.defaultRef).toBe("dogfood");
  });

  it("checks out the managed source during clone so the cleanliness guard starts clean", () => {
    expect(dogfoodCloneArgs("git@example.com:synara.git", "/tmp/dogfood-source")).toEqual([
      "clone",
      "--",
      "git@example.com:synara.git",
      "/tmp/dogfood-source",
    ]);
  });

  it("starts the desktop launcher directly so the persisted PID stays alive", () => {
    expect(dogfoodStartArgs()).toEqual(["apps/desktop/scripts/start-electron.mjs"]);
  });

  it("keeps updating the selected ref until explicitly moved", () => {
    expect(resolveDogfoodRef(parseDogfoodArgs(["setup"]), null)).toBe("dogfood");
    expect(resolveDogfoodRef(parseDogfoodArgs(["update"]), "origin/dogfood")).toBe(
      "origin/dogfood",
    );
    expect(resolveDogfoodRef(parseDogfoodArgs(["update", "--ref", "dogfood"]), "old-ref")).toBe(
      "dogfood",
    );
  });
});
