if (typeof globalThis.navigator === "undefined" || globalThis.navigator == null) {
  Object.defineProperty(globalThis, "navigator", {
    value: { userAgent: "vitest" },
    configurable: true,
    writable: true,
  });
} else if (typeof globalThis.navigator.userAgent !== "string") {
  Object.defineProperty(globalThis.navigator, "userAgent", {
    value: "vitest",
    configurable: true,
    writable: true,
  });
}
