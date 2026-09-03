// Node accepts both --max-old-space-size and --max_old_space_size (any mix
// of - and _), so detect either spelling as a whole token before appending.
const MAX_OLD_SPACE_FLAG = /(^|\s)--max[-_]old[-_]space[-_]size(=|\s|$)/;

export const withHeapLimit = (existing, sizeMb) =>
  MAX_OLD_SPACE_FLAG.test(existing)
    ? existing
    : `${existing} --max-old-space-size=${sizeMb}`.trim();
