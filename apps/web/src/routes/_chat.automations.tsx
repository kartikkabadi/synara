import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";

import { AutomationsRail } from "./-automations.shared";

export const Route = createFileRoute("/_chat/automations")({
  component: AutomationsLayout,
});

// Two-pane layout shared by /automations (template gallery) and
// /automations/$automationId (editor): the rail lists every automation with its
// trigger summary, inline pause/resume, and a filter box, mirroring monocode.
function AutomationsLayout() {
  const { automationId } = useParams({ strict: false });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <AutomationsRail selectedId={automationId ?? null} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  );
}
