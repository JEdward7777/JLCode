/**
 * The model manager's routes (X-62, D-110). Each write is load → pure op
 * (src/config/manage.ts) → save, against the live config store, so the CLI and
 * the dialog edit the same file and an open thread sees the change the way it
 * sees a `jlcode config set` (switched threads per request, folder-default
 * threads at their next turn).
 *
 * **No route returns key bytes.** Configs go out as `ManagedConfig` (values +
 * fingerprint); a key comes *in* only on a write, as `{mode: "new", value}`.
 */
import type { Hono } from "hono";
import type { Config } from "../config/types.js";
import { MODEL_CONFIG_FIELDS } from "../config/fields.js";
import {
  ManageError,
  createManaged,
  deleteManaged,
  listManaged,
  setFolderDefault,
  updateManaged,
} from "../config/manage.js";
import type { ModelCatalog } from "../llm/models.js";

export interface ModelManagerDeps {
  load: () => Config;
  save: (config: Config) => void;
  /** The folder whose default the dialog shows and sets. */
  cwd: string;
  /** The config `--config` pinned this server to, by id (it can't be deleted). */
  pinnedId?: string;
  catalog?: ModelCatalog;
  /** Don't touch the network for the catalog (the fake driver, tests). */
  offline?: boolean;
}

export function registerModelManager(app: Hono, deps: ModelManagerDeps): void {
  const fail = (err: unknown) => {
    if (err instanceof ManageError) {
      return { body: { error: err.message, ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}) }, status: err.status };
    }
    throw err;
  };
  const one = (config: Config, id: string) => listManaged(config, deps.cwd, deps.pinnedId).find((m) => m.id === id);

  app.get("/model-config-fields", (c) => c.json({ fields: MODEL_CONFIG_FIELDS }));

  app.get("/model-configs", (c) =>
    c.json({ configs: listManaged(deps.load(), deps.cwd, deps.pinnedId), workingDir: deps.cwd }),
  );

  app.post("/model-configs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { values?: unknown; key?: unknown };
    try {
      const { config, created } = createManaged(deps.load(), body);
      deps.save(config);
      return c.json({ config: one(config, created.id) }, 201);
    } catch (err) {
      const r = fail(err);
      return c.json(r.body, r.status as 400);
    }
  });

  app.put("/model-configs/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { values?: unknown; key?: unknown };
    try {
      const { config, updated, rotated } = updateManaged(deps.load(), c.req.param("id"), body);
      deps.save(config);
      return c.json({ config: one(config, updated.id), rotated });
    } catch (err) {
      const r = fail(err);
      return c.json(r.body, r.status as 400);
    }
  });

  // `?newDefault=<id>` names the replacement when this is the folder's default.
  app.delete("/model-configs/:id", (c) => {
    try {
      const newDefaultId = c.req.query("newDefault");
      const config = deleteManaged(deps.load(), c.req.param("id"), {
        cwd: deps.cwd,
        ...(deps.pinnedId ? { pinnedId: deps.pinnedId } : {}),
        ...(newDefaultId ? { newDefaultId } : {}),
      });
      deps.save(config);
      return c.json({ deleted: true });
    } catch (err) {
      const r = fail(err);
      return c.json(r.body, r.status as 400);
    }
  });

  app.post("/model-configs/:id/default", (c) => {
    try {
      deps.save(setFolderDefault(deps.load(), c.req.param("id"), deps.cwd));
      return c.json({ ok: true });
    } catch (err) {
      const r = fail(err);
      return c.json(r.body, r.status as 400);
    }
  });

  // OpenRouter's catalog for the model field's search. Refreshed when stale
  // (a day, D-44c) unless offline; a failed refresh still answers with what
  // is cached, plus the error, so the field falls back to free text.
  app.get("/model-catalog", async (c) => {
    if (!deps.catalog) return c.json({ models: [], fetchedAt: null, error: "no catalog on this server" });
    let error: string | undefined;
    if (!deps.offline) error = (await deps.catalog.refresh()).error;
    const at = deps.catalog.lastFetched;
    return c.json({
      models: deps.catalog.listModels(),
      fetchedAt: at > 0 ? new Date(at).toISOString() : null,
      ...(error ? { error } : {}),
    });
  });
}
