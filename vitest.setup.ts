// FILE: vitest.setup.ts
// Purpose: Polyfill browser globals that some dependencies read at import time
// when tests run in a Node/Vitest environment.
// Layer: Root test harness setup
// Depends on: none

if (typeof globalThis.navigator === "undefined") {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      userAgent: "vitest",
      platform: "vitest",
      maxTouchPoints: 0,
    },
    configurable: true,
    writable: true,
  });
}
