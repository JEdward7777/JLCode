/**
 * The model manager dialog's pure half (X-62, D-110): form state, clone names,
 * catalog search, the delete plan. No DOM, no React — like `model-picker.ts`.
 *
 * The form is driven by the server's field list (`GET /model-config-fields`,
 * from src/config/fields.ts), so nothing here names a config field except the
 * few a *new* config starts with.
 */
import type { CatalogModel, FieldSpec, FieldValue, KeyChoice, ManagedConfig } from "./api";

/** What the form holds per field. Numbers and JSON are edited as text and sent
 *  as text; the server validates and converts (one set of rules, not two). */
export type FormValue = string | boolean | string[] | null;
export type FormState = Record<string, FormValue>;

export function toForm(fields: FieldSpec[], values: Record<string, FieldValue>): FormState {
  const out: FormState = {};
  for (const f of fields) {
    const v = values[f.key] ?? null;
    if (v === null) out[f.key] = null;
    else if (f.type === "json") out[f.key] = JSON.stringify(v, null, 2);
    else if (f.type === "int" || f.type === "number") out[f.key] = String(v);
    else if (f.type === "multi") out[f.key] = Array.isArray(v) ? v.map(String) : [];
    else out[f.key] = v as string | boolean;
  }
  return out;
}

/** A new config's starting values — the same defaults `jlcode config add` uses. */
export function blankForm(fields: FieldSpec[]): FormState {
  const form = toForm(fields, {});
  const set = (k: string, v: FormValue) => {
    if (k in form) form[k] = v;
  };
  set("defaultMode", "code");
  set("defaultApproval", "manual");
  set("compaction.auto", true);
  return form;
}

/** "X copy", then "X copy 2", … — the first name nobody has (case-insensitive). */
export function uniqueName(base: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  const first = `${base} copy`;
  if (!used.has(first.toLowerCase())) return first;
  for (let i = 2; ; i++) {
    const n = `${first} ${i}`;
    if (!used.has(n.toLowerCase())) return n;
  }
}

export function cloneForm(fields: FieldSpec[], source: ManagedConfig, all: ManagedConfig[]): FormState {
  const form = toForm(fields, source.values);
  form["name"] = uniqueName(String(source.values["name"] ?? "config"), all.map((c) => String(c.values["name"] ?? "")));
  return form;
}

/** The fields whose value differs from where the form started. */
export function changedKeys(start: FormState, now: FormState): string[] {
  return Object.keys(now).filter((k) => JSON.stringify(start[k] ?? null) !== JSON.stringify(now[k] ?? null));
}

/** Only what changed on an edit (so a field edited in another tab or on the
 *  CLI meanwhile isn't overwritten with what this form loaded); everything on
 *  a create. */
export function payload(start: FormState, now: FormState, creating: boolean): Record<string, FieldValue> {
  const keys = creating ? Object.keys(now) : changedKeys(start, now);
  return Object.fromEntries(keys.map((k) => [k, now[k] ?? null]));
}

/** Is the key part of the form something the server will accept? */
export function keyProblem(key: KeyChoice, creating: boolean): string | null {
  if (key.mode === "keep" && creating) return "A new config needs a key: copy one or enter one.";
  if (key.mode === "new" && key.value.trim() === "") return "Enter the new key.";
  return null;
}

/** Fields grouped as the form lays them out: core first, then each advanced
 *  section in the order the server listed them. */
export function layout(fields: FieldSpec[]): { core: FieldSpec[]; sections: { title: string; fields: FieldSpec[] }[] } {
  const core = fields.filter((f) => !f.advanced);
  const sections: { title: string; fields: FieldSpec[] }[] = [];
  for (const f of fields.filter((x) => x.advanced)) {
    const title = f.section ?? "Other";
    let s = sections.find((x) => x.title === title);
    if (!s) sections.push((s = { title, fields: [] }));
    s.fields.push(f);
  }
  return { core, sections };
}

/** Catalog search: every word must appear in the id or the name. Exact id
 *  first, then by id. */
export function searchCatalog(models: CatalogModel[], query: string, limit = 50): CatalogModel[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const q = query.trim().toLowerCase();
  const hits = words.length === 0
    ? models
    : models.filter((m) => {
        const hay = `${m.id} ${m.name ?? ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
  return [...hits].sort((a, b) => Number(b.id === q) - Number(a.id === q)).slice(0, limit);
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

const money = (n: number) => `$${n < 1 ? +n.toFixed(3) : +n.toFixed(2)}`;

/** One catalog row's facts: "400K ctx · $1.25 / $10 per M · images". */
export function catalogFacts(m: CatalogModel): string {
  const parts: string[] = [];
  if (m.contextLength) parts.push(`${compact(m.contextLength)} ctx`);
  if (m.promptPerMTok !== undefined && m.completionPerMTok !== undefined) {
    parts.push(`${money(m.promptPerMTok)} / ${money(m.completionPerMTok)} per M`);
  }
  if (m.images === "yes") parts.push("images");
  return parts.join(" · ");
}

/** The "copy the key from" choices: one per distinct key, named by its configs. */
export function keySources(configs: ManagedConfig[], exceptId?: string): { fromId: string; label: string }[] {
  const byGroup = new Map<number, ManagedConfig[]>();
  for (const c of configs) {
    const list = byGroup.get(c.keyGroup) ?? [];
    list.push(c);
    byGroup.set(c.keyGroup, list);
  }
  const out: { fromId: string; label: string }[] = [];
  for (const list of byGroup.values()) {
    const source = list.find((c) => c.id !== exceptId) ?? list[0]!;
    if (list.every((c) => c.id === exceptId)) continue; // only this config holds it: "keep" covers it
    const fp = source.fingerprint ? `…${source.fingerprint}` : "(no key)";
    out.push({ fromId: source.id, label: `${fp} — ${list.map((c) => String(c.values["name"])).join(", ")}` });
  }
  return out;
}

export type DeletePlan =
  | { kind: "blocked"; reason: string }
  | { kind: "confirm"; needsDefault: boolean; candidates: ManagedConfig[] };

/** What deleting this config will ask for — mirrors the server's refusals
 *  (the server still decides). */
export function deletePlan(target: ManagedConfig, all: ManagedConfig[]): DeletePlan {
  if (all.length <= 1) return { kind: "blocked", reason: "This is the only config — add another before deleting it." };
  if (target.pinned) {
    return { kind: "blocked", reason: "This server was started with --config naming this config; it can't be deleted while it runs." };
  }
  return { kind: "confirm", needsDefault: target.folderDefault, candidates: all.filter((c) => c.id !== target.id) };
}

/** The confirm's text: what happens to the threads that use it. */
export function deleteWarning(name: string, needsDefault: boolean): string {
  return (
    `Delete "${name}"? Threads switched to it stop at their next message and ask you to pick another model; ` +
    `a turn already running finishes first.` +
    (needsDefault ? " It is this folder's default, so choose the new default — threads on the default move to it." : "")
  );
}
