/**
 * The per-thread model picker's decisions, kept out of React (X-56, D-87).
 *
 * The picker lists every model config **grouped by key** — the thread's own
 * group first — and a pick is one of three things: the config already in force
 * (nothing to do), one under the same key (one click), or one under **another
 * key**, which confirms inline naming both fingerprints, **every time** (Q3: no
 * "don't ask again"). There is deliberately no fit or cost line anywhere in
 * here (Q4): over-window and spend surface at send time, as they always have.
 *
 * The server is the authority on keys — it refuses an unconfirmed cross-key
 * POST with `code: "cross-key"` — so this module's verdict is only about what
 * to *show first*. A same-key verdict the server disagrees with still ends in
 * the confirm, built from the server's fingerprints instead of ours.
 */
import type { ConfigGroup, EntryView, ModelMissing, PendingModelSwitch } from "./api";

/** A key as the picker names it. The fingerprint is the last four characters
 *  (`****` for a key too short to spare them, `""` for no key at all), and
 *  `null` is a key the server could not name — a thread switched to a config
 *  that has since been deleted, whose key is unknown and so always confirms. */
export function keyLabel(fingerprint: string | null): string {
  if (fingerprint === null) return "an unknown key";
  if (fingerprint === "") return "no key";
  if (fingerprint === "****") return "key ****";
  return `key …${fingerprint}`;
}

/** A group's heading: its fingerprint, then the config names under it (Q3). */
export function groupHeading(g: Pick<ConfigGroup, "fingerprint" | "configs">): string {
  return `${keyLabel(g.fingerprint)} — ${g.configs.map((c) => c.name).join(", ")}`;
}

export type PickPlan =
  /** The config already governing this thread — nothing to switch. */
  | { kind: "current" }
  /** Same key: POST at once. */
  | { kind: "switch"; configId: string }
  /** Another key: confirm first, naming both. `from` null = unknown key. */
  | { kind: "confirm"; configId: string; name: string; from: string | null; to: string }
  /** Not in the list (it was deleted since the list was fetched). */
  | { kind: "unknown" };

/**
 * What clicking a config row should do.
 *
 * `currentConfigId` is **`/configs`'s own answer** — the config the branch in
 * view will run next (its switch's id, else the binding read fresh) — never
 * the slice's held config, which lags a CLI re-bind until the next turn top
 * (D-82a). A deleted switched-to config matches no row, so every row is a real
 * switch and none is "current". The thread's key is the
 * group the server marked `current`; with no such group (the server could not
 * name the thread's key) every pick is treated as cross-key, because a
 * confirmation nobody needed beats a key change nobody confirmed (D-90).
 */
export function planPick(groups: readonly ConfigGroup[], configId: string, currentConfigId: string | null): PickPlan {
  const group = groups.find((g) => g.configs.some((c) => c.id === configId));
  if (!group) return { kind: "unknown" };
  // Guarded by the group as well: the id and the group both come from the same
  // `/configs` answer and should agree, but a row outside the current group is
  // an ordinary pick (one that pins it), never a silent no-op.
  if (isCurrentRow(group, configId, currentConfigId)) return { kind: "current" };
  if (group.current) return { kind: "switch", configId };
  const from = groups.find((g) => g.current)?.fingerprint ?? null;
  const name = group.configs.find((c) => c.id === configId)!.name;
  return { kind: "confirm", configId, name, from, to: group.fingerprint };
}

/** Is this row the thread's current config? Only when its group is the one
 *  the server marked current — see {@link planPick}. */
export function isCurrentRow(group: Pick<ConfigGroup, "current">, configId: string, currentConfigId: string | null): boolean {
  return group.current && configId === currentConfigId;
}

/** The inline confirm's sentence for a cross-key pick — both keys named. */
export function crossKeyQuestion(p: { name: string; from: string | null; to: string }): string {
  // A thread whose config was deleted has no key to name; say why rather than
  // printing "an unknown key" as if it were a fingerprint.
  if (p.from === null) {
    return `${p.name} uses OpenRouter ${keyLabel(p.to)}. This thread's key can't be confirmed (its model config is gone). Switch to it?`;
  }
  return `${p.name} uses a different OpenRouter key (${keyLabel(p.to)}) from this thread's (${keyLabel(p.from)}). Switch keys?`;
}

/**
 * The confirm a server-side `cross-key` refusal asks for (D-90's 409 body:
 * `from` null when the thread's key is unknown, `to` the target's). Anything
 * else isn't one, and returns null.
 */
export function confirmFromRefusal(
  body: Record<string, unknown>,
  configId: string,
  name: string,
): Extract<PickPlan, { kind: "confirm" }> | null {
  if (body.code !== "cross-key" || typeof body.to !== "string") return null;
  return { kind: "confirm", configId, name, from: typeof body.from === "string" ? body.from : null, to: body.to };
}

/** The transcript marker at a switch entry, from its **snapshot** — so a switch
 *  to a config deleted since still says what it switched to. */
export function switchMarker(entry: Pick<EntryView, "snapshot">): string {
  const s = entry.snapshot;
  if (!s) return "switched model";
  return s.name && s.name !== s.model ? `switched to ${s.name} (${s.model})` : `switched to ${s.model}`;
}

/** The chip's pending suffix while a pick waits for the session to go idle. */
export function pendingLabel(p: PendingModelSwitch): string {
  return `→ ${p.name} · pending`;
}

/** The inline notice for a thread whose model config was deleted (Q2). */
export function missingNotice(m: ModelMissing): string {
  return `This thread's model no longer exists (${m.snapshot.name}, ${m.snapshot.model}) — pick one.`;
}

/**
 * Which routes refuse on behalf of the branch **in view**, and so may put the
 * pane into its deleted-config state. Send, retry and compact all check the
 * branch the reader is on (idle, `workingLeaf` is `activeLeaf`). An **edit**
 * does not: it checks the branch it would fork onto — the edited message's
 * parent — which can sit above a later switch to a config that still exists.
 * Blocking the pane for that would disable a composer whose branch runs fine,
 * and the inline picker's pick (written on `activeLeaf`) would fix nothing.
 */
export type MissingRoute = "send" | "retry" | "compact" | "edit";
export function refusalBlocksView(route: MissingRoute): boolean {
  return route !== "edit";
}

/** The notice for an edit refused because the branch it forks onto runs on a
 *  deleted config — said, not turned into the in-view blocked state. */
export function editRefusalNotice(m: Pick<ModelMissing, "snapshot">): string {
  return `That edit would continue on ${m.snapshot.name} (${m.snapshot.model}), a model config that no longer exists — nothing was sent. Edit a message below a later model switch, or switch this thread's model first.`;
}

/** Text handed back to the composer after a refused send, without clobbering
 *  anything typed since: the composer wins when it holds anything at all. */
export function restoredInput(current: string, refused: string): string {
  return current.trim() ? current : refused;
}
