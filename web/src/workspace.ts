/**
 * How the served workspace is written on screen (X-10). With two projects open
 * there was no way to tell one JLCode tab from another: the header showed the
 * model and the tab said "JLCode" — the name of the *tool*, not of the thing you
 * are working on. The instance's cwd is the missing identity. Pure (no DOM) so
 * it's Tier-0 testable; only the server knows `home`, so it sends it along.
 */

/** The folder name — what goes in the tab title, so a collapsed tab strip is
 *  readable (Joshua's call: the *project folder*, not the tool's name). */
export function folderName(dir: string): string {
  const parts = dir.split("/").filter((p) => p !== "");
  return parts[parts.length - 1] ?? "/";
}

/** A short, recognizable form for the header: `~` for home, and long paths keep
 *  only their first segment and the folder itself — `~/work2/…/JLCode`. The full
 *  path still goes on the `title` attribute, so nothing is actually lost. */
export function abbreviatePath(dir: string, home?: string): string {
  let text = dir;
  if (home && home !== "/" && (dir === home || dir.startsWith(home + "/"))) {
    text = "~" + dir.slice(home.length);
  }
  const parts = text.split("/");
  const lead = parts[0] === "" ? "/" : parts[0]!; // "/" for an absolute path, else "~" or a name
  const rest = parts.slice(1).filter((p) => p !== "");
  if (rest.length <= 2) return text;
  const joiner = lead === "/" ? "" : "/";
  return `${lead}${joiner}${rest[0]}/…/${rest[rest.length - 1]}`;
}

/** The marker a tab wears while a session wanted you and you were elsewhere
 *  (X-26f). A leading glyph rather than a trailing one: a collapsed tab strip
 *  truncates from the right, so anything appended is the first thing lost. */
export const ATTENTION_MARK = "●";

/** The browser tab's title. The workspace folder identifies the *instance*; a
 *  conversation label (X-09), when there is one, comes first because that's what
 *  changes as you work. `attention` prefixes the marker — the silent half of the
 *  blip (X-26), and the only half that survives a tab you never look at. */
export function tabTitle(folder: string | null, label?: string | null, attention = false): string {
  const parts = [label?.trim(), folder?.trim()].filter((p): p is string => Boolean(p));
  const text = parts.length > 0 ? parts.join(" — ") : "JLCode";
  return attention ? `${ATTENTION_MARK} ${text}` : text;
}
