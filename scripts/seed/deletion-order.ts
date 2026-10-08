/*
    Copyright 2026 Julien Javelaud

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.
*/
// -----------------------------------------------------------------------------------------------------------

// In which order can every table be emptied with DELETE, without breaking
// a foreign key? A table may only be emptied once every table pointing at
// it is empty — otherwise a RESTRICT foreign key refuses (an invitation
// still naming its sender stops that user from being deleted).
//
// That's a TOPOLOGICAL SORT of the "references" graph, here with Kahn's
// algorithm: repeatedly take the tables nothing (left) points at, then
// remove their arrows, until every table is placed. If tables remain that
// all point at each other — a cycle — no order exists, and that's an
// error rather than a guess.
//
// Pure (tables and foreign keys in, order out): the reset reads both from
// Postgres's own catalog at run time, so a table added by a future
// migration is handled with no change here.

export interface ForeignKey {
  // The table holding the reference (e.g. invitations)…
  from: string
  // …and the table it points at (e.g. users).
  to: string
}

export function deletionOrder(
  tables: string[],
  foreignKeys: ForeignKey[],
): string[] {
  const known = new Set(tables)
  // pointedAtBy.get(t) = the tables that reference t (must go before t).
  const pointedAtBy = new Map<string, Set<string>>(
    tables.map((t) => [t, new Set()]),
  )
  for (const { from, to } of foreignKeys) {
    // A table referencing itself doesn't constrain the ORDER (one DELETE
    // empties it); a key to a table outside the list can't be ordered here.
    if (from === to || !known.has(from) || !known.has(to)) continue
    pointedAtBy.get(to)?.add(from)
  }

  const order: string[] = []
  const placed = new Set<string>()
  while (order.length < tables.length) {
    // Every table whose referencing tables are all already emptied.
    // Sorted, so the order is the same on every run (easier to read and
    // to test) — any valid order would work.
    const ready = tables
      .filter((t) => !placed.has(t))
      .filter((t) =>
        [...(pointedAtBy.get(t) ?? [])].every((r) => placed.has(r)),
      )
      .sort()
    if (ready.length === 0) {
      const stuck = tables.filter((t) => !placed.has(t)).sort()
      throw new Error(
        `Foreign keys form a cycle between: ${stuck.join(', ')} — no deletion order exists.`,
      )
    }
    for (const table of ready) {
      order.push(table)
      placed.add(table)
    }
  }
  return order
}