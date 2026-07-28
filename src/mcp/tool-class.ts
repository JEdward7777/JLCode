/**
 * Learned write-classification for MCP tools (D-48).
 *
 * JLCode can't trust an MCP server to describe its own risk, so a discovered
 * tool is presumed to write (D-47b). That presumption is safe but lossy: a
 * genuinely read-only tool then prompts forever under `manual`/`auto-safe`, and
 * is denied outright in Ask mode. The server's `annotations.readOnlyHint`
 * settles it automatically when present; when it isn't, the user settles it —
 * once — at a pause that was happening anyway, and the answer is persisted per
 * server in `mcp_settings.json` beside the path-field lists:
 *
 *   - `writeTools` — confirmed to change state → keeps the strict class
 *   - `readTools`  — confirmed read-only → demoted to `kind:"read"`
 *
 * `unknown` (in neither list, no hint) still behaves exactly like a write. The
 * learning never loosens a call in flight without the user saying so.
 */

export type WriteVerdict = "write" | "read" | "unknown";

export interface ToolClassLists {
  writeTools?: string[];
  readTools?: string[];
}

/** What we know about one MCP tool's write-ness. `readOnlyHint` wins outright. */
export function classifyTool(tool: string, lists: ToolClassLists, readOnlyHint?: boolean): WriteVerdict {
  if (readOnlyHint === true) return "read";
  if (lists.writeTools?.includes(tool)) return "write";
  if (lists.readTools?.includes(tool)) return "read";
  return "unknown";
}

/** Apply an answer to the learned lists, keeping them de-duplicated. */
export function rememberTool(lists: ToolClassLists, tool: string, writes: boolean): Required<ToolClassLists> {
  const writeTools = (lists.writeTools ?? []).filter((t) => t !== tool);
  const readTools = (lists.readTools ?? []).filter((t) => t !== tool);
  if (writes) writeTools.push(tool);
  else readTools.push(tool);
  return { writeTools, readTools };
}
