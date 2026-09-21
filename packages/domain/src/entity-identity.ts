import type { CanonEntity } from "./canon.js";

type NamedEntity = Pick<CanonEntity, "type" | "name" | "aliases">;

/** Conservative identity collision check, not an automatic semantic merge. */
export function entityNamesOverlap(a: NamedEntity, b: NamedEntity): boolean {
  if (a.type !== b.type) return false;
  const normalize = (name: string) =>
    name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const names = new Set([a.name, ...a.aliases].map(normalize).filter(Boolean));
  return [b.name, ...b.aliases].some((name) => names.has(normalize(name)));
}
