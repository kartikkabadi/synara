import { describe, expect, it } from "vitest";

import {
  resolveSynaraDesktopFlavor,
  SYNARA_CANARY_BUNDLE_ID,
  SYNARA_CANARY_DESKTOP_ENTRY_URL,
  SYNARA_CANARY_DESKTOP_ORIGIN,
  SYNARA_DESKTOP_ENTRY_URL,
  SYNARA_DESKTOP_ORIGIN,
  SYNARA_DESKTOP_UPDATE_CHANNEL,
  SYNARA_DEVELOPMENT_BUNDLE_ID,
  SYNARA_DOGFOOD_BUNDLE_ID,
  SYNARA_DOGFOOD_DESKTOP_ENTRY_URL,
  SYNARA_DOGFOOD_DESKTOP_ORIGIN,
  SYNARA_PRODUCTION_BUNDLE_ID,
  synaraBundleId,
  synaraDesktopIdentity,
} from "./desktopIdentity";

describe("desktopIdentity", () => {
  it("uses the exact canonical production and development bundle IDs", () => {
    expect(SYNARA_PRODUCTION_BUNDLE_ID).toBe("com.emanueledipietro.synara");
    expect(SYNARA_DEVELOPMENT_BUNDLE_ID).toBe("com.emanueledipietro.synara.dev");
    expect(synaraBundleId(false)).toBe(SYNARA_PRODUCTION_BUNDLE_ID);
    expect(synaraBundleId(true)).toBe(SYNARA_DEVELOPMENT_BUNDLE_ID);
  });

  it("uses the exact packaged renderer origin and entry URL", () => {
    expect(SYNARA_DESKTOP_ORIGIN).toBe("synara://app");
    expect(SYNARA_DESKTOP_ENTRY_URL).toBe("synara://app/index.html");
  });

  it("uses the isolated Synara desktop update channel", () => {
    expect(SYNARA_DESKTOP_UPDATE_CHANNEL).toBe("synara");
  });

  it("gives Canary a fully separate desktop identity and storage profile", () => {
    expect(SYNARA_CANARY_BUNDLE_ID).toBe("com.emanueledipietro.synara.canary");
    expect(SYNARA_CANARY_DESKTOP_ORIGIN).toBe("synara-canary://app");
    expect(SYNARA_CANARY_DESKTOP_ENTRY_URL).toBe("synara-canary://app/index.html");
    expect(synaraDesktopIdentity("canary")).toEqual({
      flavor: "canary",
      displayName: "Synara Canary",
      bundleId: SYNARA_CANARY_BUNDLE_ID,
      scheme: "synara-canary",
      origin: SYNARA_CANARY_DESKTOP_ORIGIN,
      entryUrl: SYNARA_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "synara-canary",
      defaultHomeDirectoryName: ".synara-canary",
      usesScriptedUpdates: true,
    });
  });

  it("gives Dogfood a fully separate desktop identity, storage profile, and icon", () => {
    expect(SYNARA_DOGFOOD_BUNDLE_ID).toBe("com.emanueledipietro.synara.dogfood");
    expect(SYNARA_DOGFOOD_DESKTOP_ORIGIN).toBe("synara-dogfood://app");
    expect(SYNARA_DOGFOOD_DESKTOP_ENTRY_URL).toBe("synara-dogfood://app/index.html");
    expect(synaraDesktopIdentity("dogfood")).toEqual({
      flavor: "dogfood",
      displayName: "Synara Dogfood",
      bundleId: SYNARA_DOGFOOD_BUNDLE_ID,
      scheme: "synara-dogfood",
      origin: SYNARA_DOGFOOD_DESKTOP_ORIGIN,
      entryUrl: SYNARA_DOGFOOD_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "synara-dogfood",
      defaultHomeDirectoryName: ".synara-dogfood",
      usesScriptedUpdates: true,
      iconFileName: "icon-dogfood.icns",
    });
  });

  it("selects Canary and Dogfood explicitly without changing normal dev and production defaults", () => {
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false })).toBe("production");
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true })).toBe("development");
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: " canary " })).toBe(
      "canary",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true, requestedFlavor: "canary" })).toBe(
      "canary",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: false, requestedFlavor: "dogfood" })).toBe(
      "dogfood",
    );
    expect(resolveSynaraDesktopFlavor({ isDevelopment: true, requestedFlavor: " dogfood " })).toBe(
      "dogfood",
    );
  });
});
