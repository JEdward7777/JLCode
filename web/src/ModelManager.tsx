/**
 * The model manager dialog (X-62, D-110): every model config, grouped by key,
 * with create / clone / edit / delete, the key handled as keep / copy / new,
 * and this folder's default. Opened from the model picker's gear.
 *
 * The form is built from the server's field list, so a field added to
 * src/config/fields.ts shows up here with no change to this file. Keys never
 * arrive here; a new key leaves only inside a save.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  createManagedConfig,
  deleteManagedConfig,
  fetchConfigFields,
  fetchManagedConfigs,
  fetchModelCatalog,
  setManagedDefault,
  updateManagedConfig,
  type CatalogModel,
  type FieldSpec,
  type KeyChoice,
  type ManagedConfig,
} from "./api";
import {
  blankForm,
  catalogFacts,
  changedKeys,
  cloneForm,
  deletePlan,
  deleteWarning,
  keyProblem,
  keySources,
  layout,
  payload,
  searchCatalog,
  toForm,
  type FormState,
  type FormValue,
} from "./model-manager";

type Editing = { kind: "edit"; id: string } | { kind: "new"; cloneOf?: string };

export function ModelManager({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void }) {
  const [fields, setFields] = useState<FieldSpec[] | null>(null);
  const [configs, setConfigs] = useState<ManagedConfig[]>([]);
  const [workingDir, setWorkingDir] = useState("");
  const [catalog, setCatalog] = useState<{ models: CatalogModel[]; error?: string } | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [start, setStart] = useState<FormState>({});
  const [form, setForm] = useState<FormState>({});
  const [key, setKey] = useState<KeyChoice>({ mode: "keep" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ newDefault: string } | null>(null);
  const [help, setHelp] = useState<Set<string>>(new Set());

  const current = editing?.kind === "edit" ? configs.find((c) => c.id === editing.id) : undefined;
  const creating = editing?.kind === "new";
  const dirty = editing !== null && (creating || changedKeys(start, form).length > 0 || key.mode !== "keep");

  const load = async (select?: string) => {
    const [f, list] = await Promise.all([fields ? Promise.resolve(fields) : fetchConfigFields(), fetchManagedConfigs()]);
    setFields(f);
    setConfigs(list.configs);
    setWorkingDir(list.workingDir);
    const pick = list.configs.find((c) => c.id === select) ?? list.configs.find((c) => c.folderDefault) ?? list.configs[0];
    if (pick) openEdit(pick, f);
    return list.configs;
  };

  useEffect(() => {
    load().catch((err) => setError((err as Error).message));
    fetchModelCatalog()
      .then(setCatalog)
      .catch((err) => setCatalog({ models: [], error: (err as Error).message }));
    // Escape closes, unless a change would be lost.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeIfClean();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const leaveOk = () => !dirtyRef.current || window.confirm("Discard the unsaved changes to this config?");
  const closeIfClean = () => leaveOk() && onClose();

  const reset = (next: Editing, f: FormState, k: KeyChoice) => {
    setEditing(next);
    setStart(f);
    setForm(f);
    setKey(k);
    setFieldErrors({});
    setError(null);
    setConfirmDelete(null);
  };
  function openEdit(c: ManagedConfig, f: FieldSpec[] | null = fields) {
    if (!f) return;
    reset({ kind: "edit", id: c.id }, toForm(f, c.values), { mode: "keep" });
  }
  const select = (c: ManagedConfig) => {
    if (editing?.kind === "edit" && editing.id === c.id) return;
    if (!leaveOk()) return;
    setNotice(null);
    openEdit(c);
  };
  const startNew = () => {
    if (!fields || !leaveOk()) return;
    setNotice(null);
    reset({ kind: "new" }, blankForm(fields), { mode: "new", value: "" });
  };
  const startClone = (src: ManagedConfig) => {
    if (!fields || !leaveOk()) return;
    setNotice(null);
    reset({ kind: "new", cloneOf: src.id }, cloneForm(fields, src, configs), { mode: "copy", fromId: src.id });
  };

  const save = async () => {
    if (!editing) return;
    const problem = keyProblem(key, creating);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const values = payload(start, form, creating);
      if (creating) {
        const made = await createManagedConfig(values, key);
        await load(made.id);
        setNotice(`Created "${String(made.values["name"])}".`);
      } else {
        const { config, rotated } = await updateManagedConfig(editing.id, values, key);
        await load(config.id);
        setNotice(`Saved.${rotated > 0 ? ` The new key also replaced the old one on ${rotated} other config${rotated === 1 ? "" : "s"}.` : ""}`);
      }
      onChanged?.();
    } catch (err) {
      if (err instanceof ApiError && err.body["fieldErrors"]) setFieldErrors(err.body["fieldErrors"] as Record<string, string>);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (c: ManagedConfig) => {
    setBusy(true);
    try {
      await setManagedDefault(c.id);
      await load(editing?.kind === "edit" ? editing.id : c.id);
      setNotice(`"${String(c.values["name"])}" is now this folder's default.`);
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const plan = current ? deletePlan(current, configs) : null;
  const doDelete = async () => {
    if (!current || !confirmDelete) return;
    setBusy(true);
    try {
      await deleteManagedConfig(current.id, plan?.kind === "confirm" && plan.needsDefault ? confirmDelete.newDefault : undefined);
      const name = String(current.values["name"]);
      dirtyRef.current = false;
      await load(plan?.kind === "confirm" && plan.needsDefault ? confirmDelete.newDefault : undefined);
      setNotice(`Deleted "${name}".`);
      onChanged?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const groups = useMemo(() => {
    const m = new Map<number, ManagedConfig[]>();
    for (const c of configs) m.set(c.keyGroup, [...(m.get(c.keyGroup) ?? []), c]);
    return [...m.values()];
  }, [configs]);

  const set = (k: string, v: FormValue) => setForm((f) => ({ ...f, [k]: v }));
  const toggleHelp = (k: string) =>
    setHelp((h) => {
      const n = new Set(h);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const renderField = (f: FieldSpec) => (
    // Keyed by the config too, so an input's local state (the model search)
    // starts fresh when another config is opened.
    <div className={`mm-field ${fieldErrors[f.key] ? "bad" : ""}`} key={`${editing?.kind === "edit" ? editing.id : "new"}:${f.key}`}>
      <label className="mm-label">
        <span>
          {f.label}
          {f.required && <span className="mm-req"> *</span>}
        </span>
        <button
          type="button"
          className={`mm-info ${help.has(f.key) ? "on" : ""}`}
          aria-label={`what is ${f.label}?`}
          aria-expanded={help.has(f.key)}
          title={f.help}
          onClick={() => toggleHelp(f.key)}
        >
          i
        </button>
      </label>
      {help.has(f.key) && <div className="mm-help">{f.help}</div>}
      <FieldInput field={f} value={form[f.key] ?? null} onChange={(v) => set(f.key, v)} catalog={catalog} />
      {fieldErrors[f.key] && <div className="mm-field-error">{fieldErrors[f.key]}</div>}
    </div>
  );

  const parts = fields ? layout(fields) : null;
  const sources = keySources(configs, current?.id);

  return (
    <div className="mm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeIfClean()}>
      <div className="mm-dialog" role="dialog" aria-modal="true" aria-label="manage model configs">
        <header className="mm-header">
          <h2>Model configs</h2>
          <span className="mm-folder" title="the folder whose default is marked and set here">
            {workingDir}
          </span>
          <button className="mm-close ghost" onClick={closeIfClean} aria-label="close">
            ×
          </button>
        </header>
        <div className="mm-body">
          <aside className="mm-list">
            {groups.map((g) => (
              <div className="mm-group" key={g[0]!.keyGroup}>
                <div className="mm-group-head">key {g[0]!.fingerprint ? `…${g[0]!.fingerprint}` : "(none)"}</div>
                {g.map((c) => (
                  <button
                    key={c.id}
                    className={`mm-row ${editing?.kind === "edit" && editing.id === c.id ? "on" : ""}`}
                    onClick={() => select(c)}
                  >
                    <span className="mp-name">{String(c.values["name"])}</span>
                    <span className="mp-model">{String(c.values["model"])}</span>
                    <span className="mm-tags">
                      {c.folderDefault && <span className="mp-tag">folder default</span>}
                      {c.pinned && <span className="mp-tag">pinned</span>}
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {creating && (
              <div className="mm-row on mm-row-new">
                <span className="mp-name">{String(form["name"] || "New config")}</span>
                <span className="mp-model">{editing.cloneOf ? "clone — not saved yet" : "not saved yet"}</span>
              </div>
            )}
            <button className="mm-new" onClick={startNew} disabled={busy || !fields}>
              + New config
            </button>
          </aside>

          <section className="mm-editor">
            {!fields && !error && <div className="mp-loading">loading…</div>}
            {fields && editing && parts && (
              <>
                <div className="mm-actions">
                  <h3>{creating ? (editing.cloneOf ? "Clone" : "New config") : String(current?.values["name"] ?? "")}</h3>
                  {current && (
                    <>
                      <button className="ghost" disabled={busy} onClick={() => startClone(current)} title="a new config with these settings and this key">
                        Clone
                      </button>
                      <button
                        className="ghost"
                        disabled={busy || current.folderDefault}
                        onClick={() => void makeDefault(current)}
                        title="new threads in this folder start on it"
                      >
                        {current.folderDefault ? "Folder default" : "Make folder default"}
                      </button>
                      <button
                        className="ghost danger-text"
                        disabled={busy}
                        onClick={() => setConfirmDelete({ newDefault: plan?.kind === "confirm" ? (plan.candidates[0]?.id ?? "") : "" })}
                      >
                        Delete…
                      </button>
                    </>
                  )}
                </div>

                {current && confirmDelete && plan && (
                  <div className="mp-confirm" role="alertdialog">
                    {plan.kind === "blocked" ? (
                      <span>{plan.reason}</span>
                    ) : (
                      <>
                        <span>{deleteWarning(String(current.values["name"]), plan.needsDefault)}</span>
                        {plan.needsDefault && (
                          <label className="mm-inline">
                            New default:{" "}
                            <select value={confirmDelete.newDefault} onChange={(e) => setConfirmDelete({ newDefault: e.target.value })}>
                              {plan.candidates.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {String(c.values["name"])} — {String(c.values["model"])}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                      </>
                    )}
                    <div className="mp-confirm-actions">
                      {plan.kind === "confirm" && (
                        <button className="danger" disabled={busy} onClick={() => void doDelete()}>
                          Delete
                        </button>
                      )}
                      <button className="ghost" onClick={() => setConfirmDelete(null)}>
                        {plan.kind === "confirm" ? "Cancel" : "OK"}
                      </button>
                    </div>
                  </div>
                )}

                <div className="mm-form">
                  {parts.core.map(renderField)}

                  <fieldset className="mm-key">
                    <legend>OpenRouter key</legend>
                    {current && (
                      <label className="mm-radio">
                        <input type="radio" checked={key.mode === "keep"} onChange={() => setKey({ mode: "keep" })} />
                        Keep the current key {current.fingerprint ? `(…${current.fingerprint})` : "(none)"}
                        {current.sharedWith > 0 && <span className="mm-muted"> — shared with {current.sharedWith} other config{current.sharedWith === 1 ? "" : "s"}</span>}
                      </label>
                    )}
                    {sources.length > 0 && (
                      <label className="mm-radio">
                        <input
                          type="radio"
                          checked={key.mode === "copy"}
                          onChange={() => setKey({ mode: "copy", fromId: sources[0]!.fromId })}
                        />
                        Use the key from{" "}
                        <select
                          disabled={key.mode !== "copy"}
                          value={key.mode === "copy" ? key.fromId : sources[0]!.fromId}
                          onChange={(e) => setKey({ mode: "copy", fromId: e.target.value })}
                        >
                          {sources.map((s) => (
                            <option key={s.fromId} value={s.fromId}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="mm-radio">
                      <input type="radio" checked={key.mode === "new"} onChange={() => setKey({ mode: "new", value: "" })} />
                      Enter a new key
                    </label>
                    {key.mode === "new" && (
                      <div className="mm-newkey">
                        <input
                          type="password"
                          autoComplete="off"
                          placeholder="sk-or-…"
                          value={key.value}
                          onChange={(e) => setKey({ ...key, value: e.target.value })}
                        />
                        {current && current.sharedWith > 0 && (
                          <label className="mm-check">
                            <input
                              type="checkbox"
                              checked={key.rotate === true}
                              onChange={(e) => setKey({ ...key, rotate: e.target.checked })}
                            />
                            Also replace it on the {current.sharedWith} other config{current.sharedWith === 1 ? "" : "s"} using …{current.fingerprint}
                          </label>
                        )}
                      </div>
                    )}
                    <div className="mm-help">The key is stored on this machine only and never shown here; only its last four characters are.</div>
                  </fieldset>

                  <details className="mm-advanced">
                    <summary>Advanced settings</summary>
                    {parts.sections.map((s) => (
                      <div className="mm-section" key={s.title}>
                        <h4>{s.title}</h4>
                        {s.fields.map(renderField)}
                      </div>
                    ))}
                  </details>
                </div>

                <footer className="mm-footer">
                  {error && <span className="mp-error">{error}</span>}
                  {notice && !error && <span className="mp-notice" role="status">{notice}</span>}
                  <span className="mm-spacer" />
                  {!creating && (
                    <button className="ghost" disabled={busy || !dirty} onClick={() => current && openEdit(current)}>
                      Revert
                    </button>
                  )}
                  {creating && (
                    <button className="ghost" disabled={busy} onClick={() => { dirtyRef.current = false; const c = configs.find((x) => x.folderDefault) ?? configs[0]; if (c) openEdit(c); }}>
                      Cancel
                    </button>
                  )}
                  <button className="mm-save" disabled={busy || !dirty} onClick={() => void save()}>
                    {creating ? "Create" : "Save"}
                  </button>
                </footer>
              </>
            )}
            {error && !editing && <div className="mp-error">{error}</div>}
          </section>
        </div>
      </div>
    </div>
  );
}

/** One field's input, by type. Blank always means "the default" for an
 *  optional field, and the placeholder says what that default is. */
function FieldInput({
  field: f,
  value,
  onChange,
  catalog,
}: {
  field: FieldSpec;
  value: FormValue;
  onChange: (v: FormValue) => void;
  catalog: { models: CatalogModel[]; error?: string } | null;
}) {
  const hint = f.defaultHint ?? "";
  switch (f.type) {
    case "model":
      return <ModelInput value={typeof value === "string" ? value : ""} onChange={(v) => onChange(v || null)} catalog={catalog} placeholder={hint || "vendor/model"} />;
    case "textarea":
    case "json":
      return (
        <textarea
          className={f.type === "json" ? "mono" : ""}
          rows={f.type === "json" ? 4 : 5}
          value={typeof value === "string" ? value : ""}
          placeholder={f.type === "json" ? '{"only": ["vendor/endpoint"]}' : hint}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        />
      );
    case "bool":
    case "tristate": {
      const v = value === true ? "true" : value === false ? "false" : "";
      const labels = f.type === "bool" ? ["on", "off"] : ["yes", "no"];
      return (
        <select value={v} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "true")}>
          <option value="">{f.type === "bool" ? `default (${f.defaultHint ?? "—"})` : "auto"}</option>
          <option value="true">{labels[0]}</option>
          <option value="false">{labels[1]}</option>
        </select>
      );
    }
    case "enum":
      return (
        <select value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}>
          {!f.required && <option value="">{`default${f.defaultHint ? ` (${f.defaultHint})` : ""}`}</option>}
          {(f.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "multi": {
      const list = Array.isArray(value) ? value : [];
      return (
        <div className="mm-multi">
          {(f.options ?? []).map((o) => (
            <label key={o} className="mm-check">
              <input
                type="checkbox"
                checked={list.includes(o)}
                onChange={(e) => {
                  const next = e.target.checked ? [...list, o] : list.filter((x) => x !== o);
                  onChange(next.length === 0 ? null : next);
                }}
              />
              {o}
            </label>
          ))}
        </div>
      );
    }
    default:
      return (
        <input
          type="text"
          inputMode={f.type === "int" ? "numeric" : f.type === "number" ? "decimal" : undefined}
          value={typeof value === "string" ? value : ""}
          placeholder={hint}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        />
      );
  }
}

/** The model slug: type to search OpenRouter's catalog, or type any slug. */
function ModelInput({
  value,
  onChange,
  catalog,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  catalog: { models: CatalogModel[]; error?: string } | null;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const hits = catalog ? searchCatalog(catalog.models, query ?? "", 40) : [];
  const known = catalog?.models.find((m) => m.id === value);
  return (
    <div className="mm-model" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOpen(false)}>
      <input
        type="text"
        className="mono"
        value={query ?? value}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          onChange(e.target.value.trim());
          setOpen(true);
        }}
      />
      {known && query === null && <div className="mm-muted mm-facts">{[known.name, catalogFacts(known)].filter(Boolean).join(" · ")}</div>}
      {value && catalog && catalog.models.length > 0 && !known && query === null && (
        <div className="mm-muted mm-facts">not in OpenRouter's catalog — used as typed</div>
      )}
      {open && (
        <div className="mm-catalog" role="listbox">
          {catalog === null && <div className="mp-loading">loading OpenRouter's catalog…</div>}
          {catalog?.error && catalog.models.length === 0 && <div className="mp-loading">catalog unavailable ({catalog.error}) — type a slug</div>}
          {hits.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === value}
              className={`mm-cat-row ${m.id === value ? "on" : ""}`}
              onClick={() => {
                onChange(m.id);
                setQuery(null);
                setOpen(false);
              }}
            >
              <span className="mp-model">{m.id}</span>
              <span className="mm-muted">{[m.name, catalogFacts(m)].filter(Boolean).join(" · ")}</span>
            </button>
          ))}
          {catalog && catalog.models.length > 0 && hits.length === 0 && <div className="mp-loading">no match — the slug is used as typed</div>}
        </div>
      )}
    </div>
  );
}
