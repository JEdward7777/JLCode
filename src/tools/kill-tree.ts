/**
 * Spawning and killing a command's whole process tree, per platform (D-104,
 * D-105a). The one place `run_command` learns which OS it is on.
 *
 *   - **POSIX** spawns the child as its own process-group leader (`detached`)
 *     and kills with a synchronous `process.kill(-pid)`: the group is the tree,
 *     reparented grandchildren included, and nothing is spawned to do it.
 *     `tree-kill` is deliberately *not* used here (D-105a): on POSIX it walks
 *     `ps`/`pgrep` instead of the group, races, misses reparented grandchildren,
 *     and its helper spawn has no `error` listener — a host without `ps` would
 *     crash the server.
 *   - **win32** has no process groups to signal, and the negative-PID kill
 *     throws there (falling back to the shell alone, leaving its children). So
 *     it goes through `tree-kill`, which runs `taskkill /T /F` (D-45: a library,
 *     not a hand-rolled fallback).
 *
 * Every child spawns with `windowsHide`, so a background command on Windows
 * doesn't flash a console window. The platform is a parameter so both branches
 * are unit-tested on any host — Windows itself cannot be exercised here.
 */
import type { ChildProcess, SpawnOptions } from "node:child_process";
import treeKill from "tree-kill";

/** The spawn options for a shell command on `platform`. */
export function shellSpawnOptions(cwd: string, platform: NodeJS.Platform = process.platform): SpawnOptions {
  return {
    cwd,
    shell: true,
    // Own process group on POSIX, so a kill takes the whole tree (D-105a). On
    // win32 `detached` would mean a new console instead, which buys nothing:
    // taskkill /T walks the tree by parent pid.
    detached: platform !== "win32",
    windowsHide: true,
  };
}

export interface KillDeps {
  /** `process.kill`, injectable for the platform-mocked tests. */
  processKill?: (pid: number, signal: NodeJS.Signals) => void;
  /** `tree-kill`, injectable likewise. */
  treeKill?: (pid: number, signal: string, callback: (error?: Error) => void) => void;
}

/**
 * Kill `child` and everything it launched. Never throws: the process may be gone
 * already, and a kill is called from timers, Stop and dispose, none of which can
 * do anything useful with an error.
 */
export function killTree(
  child: Pick<ChildProcess, "pid" | "kill">,
  platform: NodeJS.Platform = process.platform,
  deps: KillDeps = {},
): void {
  const fallback = (): void => {
    try {
      child.kill("SIGKILL"); // the child alone — better than nothing
    } catch {
      /* already gone */
    }
  };
  const pid = child.pid;
  if (pid === undefined) return fallback(); // never started: nothing to walk
  if (platform === "win32") {
    try {
      // Asynchronous (it spawns taskkill); the callback swallows "not found",
      // and an error there falls back to the shell alone.
      (deps.treeKill ?? treeKill)(pid, "SIGKILL", (error) => {
        if (error) fallback();
      });
    } catch {
      fallback();
    }
    return;
  }
  try {
    (deps.processKill ?? process.kill)(-pid, "SIGKILL");
  } catch {
    fallback();
  }
}
