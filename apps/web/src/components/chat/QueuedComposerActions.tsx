// FILE: QueuedComposerActions.tsx
// Purpose: Inline action cluster (Steer / Delete / Menu) rendered on each queued
// composer row. Used in both the compact and expanded composer layouts so the
// action chrome stays in lockstep across surfaces.
// Layer: Chat composer UI primitive
// Exports: QueuedComposerActions

import { EllipsisIcon, SteerIcon, Trash2 } from "~/lib/icons";

import type { QueuedComposerTurn } from "../../composerDraftStore";

import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";

type QueuedComposerActionsProps = {
  queuedTurn: QueuedComposerTurn;
  // While a loop is active the server folds the chip into the loop as the
  // next objective instead of interrupting, so the copy promises exactly that.
  loopActive?: boolean;
  onSteer: (queuedTurn: QueuedComposerTurn) => void;
  onRemove: (queuedTurnId: string) => void;
  onEdit: (queuedTurn: QueuedComposerTurn) => void;
};

function QueuedComposerActions({
  queuedTurn,
  loopActive = false,
  onSteer,
  onRemove,
  onEdit,
}: QueuedComposerActionsProps) {
  return (
    <div className="flex shrink-0 items-center gap-0">
      <Button
        variant="subtle"
        size="chip"
        title={loopActive ? "Applies as the loop's objective when this turn ends" : undefined}
        onClick={() => void onSteer(queuedTurn)}
      >
        <SteerIcon />
        <span>{loopActive ? "Next objective" : "Steer"}</span>
      </Button>
      <IconButton
        variant="ghost"
        size="icon-chip"
        label={loopActive ? "Delete queued objective" : "Delete queued follow-up"}
        onClick={() => onRemove(queuedTurn.id)}
      >
        <Trash2 />
      </IconButton>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-chip"
              aria-label="Queued follow-up actions"
              className="[&_svg]:mx-0"
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <ComposerPickerMenuPopup align="end" side="top" sideOffset={6}>
          <MenuItem onClick={() => onEdit(queuedTurn)}>
            {loopActive ? "Edit queued objective" : "Edit queued prompt"}
          </MenuItem>
          <MenuItem onClick={() => onRemove(queuedTurn.id)}>
            {loopActive ? "Delete queued objective" : "Delete queued prompt"}
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
    </div>
  );
}

export { QueuedComposerActions };
