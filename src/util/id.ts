/** Short, stable, collision-resistant ids (e.g. `cfg_9f83c1a0b2d4`). */
import { randomBytes } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}
