// FILE: island.tsx
// Purpose: Registers the island overlay renderer, loaded only by the dedicated island BrowserWindow.
// Layer: Route
// Exports: Route

import { createFileRoute } from "@tanstack/react-router";

import { Island } from "~/components/island/Island";

export const Route = createFileRoute("/island")({
  component: Island,
});
