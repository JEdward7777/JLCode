/**
 * Learned path-field classification for MCP tool arguments (D-47d).
 *
 * Native tools declare `pathArgs` by hand, which only reaches top-level string
 * args. MCP arguments are arbitrary JSON from a server we don't control, so
 * instead we **flatten** them to jq-style field paths and consult two lists kept
 * per server in `mcp_settings.json`:
 *
 *   - `pathFields`    — this field is a filesystem path → run the D-19 fence
 *   - `notPathFields` — this field is not → never fenced
 *
 * A string value **containing a slash** whose field is in neither list is
 * `unknown`: the session asks the user once and persists the answer. Until it is
 * answered, an unknown field is treated as a path (fail-closed).
 *
 * Field names collapse array indices (`edits[].path`, not `edits.0.path`) so one
 * answer covers every element — jq's own spelling, minus the leading dot.
 */

export interface FlatField {
  /** jq-style flattened field name, e.g. `path` or `edits[].content`. */
  field: string;
  value: string;
}

/** Every string leaf in an argument object, with its flattened field name. */
export function flattenStringArgs(args: unknown, prefix = ""): FlatField[] {
  const out: FlatField[] = [];
  const walk = (node: unknown, field: string): void => {
    if (typeof node === "string") {
      out.push({ field, value: node });
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, `${field}[]`);
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        walk(value, field === "" ? key : `${field}.${key}`);
      }
    }
  };
  walk(args, prefix);
  return out;
}

/** Does this value look enough like a path to be worth asking about? (D-47d) */
export function looksLikePath(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

export type FieldVerdict = "path" | "not-path" | "unknown";

export interface FieldLists {
  pathFields?: string[];
  notPathFields?: string[];
}

/** Classify one flattened field against a server's learned lists. */
export function classifyField(field: string, value: string, lists: FieldLists): FieldVerdict {
  if (lists.pathFields?.includes(field)) return "path";
  if (lists.notPathFields?.includes(field)) return "not-path";
  return looksLikePath(value) ? "unknown" : "not-path";
}

export interface ClassifiedArgs {
  /** Fields to fence — known paths plus, fail-closed, the unanswered ones. */
  paths: FlatField[];
  /** Fields the user has never been asked about that look like paths. */
  unknown: FlatField[];
}

/** Classify every string arg of a call. */
export function classifyArgs(args: unknown, lists: FieldLists): ClassifiedArgs {
  const paths: FlatField[] = [];
  const unknown: FlatField[] = [];
  const seenUnknown = new Set<string>();
  for (const entry of flattenStringArgs(args)) {
    const verdict = classifyField(entry.field, entry.value, lists);
    if (verdict === "not-path") continue;
    paths.push(entry); // `unknown` is fenced too, until it is answered
    if (verdict === "unknown" && !seenUnknown.has(entry.field)) {
      seenUnknown.add(entry.field);
      unknown.push(entry);
    }
  }
  return { paths, unknown };
}

/** Apply an answer to the learned lists, keeping them de-duplicated. */
export function rememberField(lists: FieldLists, field: string, isPath: boolean): Required<FieldLists> {
  const pathFields = (lists.pathFields ?? []).filter((f) => f !== field);
  const notPathFields = (lists.notPathFields ?? []).filter((f) => f !== field);
  if (isPath) pathFields.push(field);
  else notPathFields.push(field);
  return { pathFields, notPathFields };
}
