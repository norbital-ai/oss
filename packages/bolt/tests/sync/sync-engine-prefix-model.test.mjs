import assert from "node:assert/strict";
import test from "node:test";

const compareRows = (left, right) =>
  left.order - right.order || left.id.localeCompare(right.id);

const authoritative = (rows, limit) =>
  [...rows.values()]
    .filter((row) => row.matches)
    .sort(compareRows)
    .slice(0, limit);

const isAfter = (row, boundary) => compareRows(row, boundary) > 0;

/**
 * Pure model of RFC/sync-engine.md section 6:
 * survivors + bounded rows after the old boundary + current probes, then sort/truncate.
 */
const transition = ({ oldPrefix, currentRows, changedIds, limit }) => {
  const changed = new Set(changedIds);
  const survivors = oldPrefix.filter((row) => !changed.has(row.id));
  const vacancies = oldPrefix.length - survivors.length;
  const oldBoundary = oldPrefix.at(-1);
  const boundaryRows =
    oldBoundary === undefined
      ? []
      : [...currentRows.values()]
          .filter(
            (row) =>
              row.matches && !changed.has(row.id) && isAfter(row, oldBoundary),
          )
          .sort(compareRows)
          .slice(0, vacancies);
  const probes = [...changed]
    .map((id) => currentRows.get(id))
    .filter((row) => row?.matches === true);
  const byId = new Map(
    [...survivors, ...boundaryRows, ...probes].map((row) => [row.id, row]),
  );
  return [...byId.values()].sort(compareRows).slice(0, limit);
};

const compact = (events) => {
  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined) return undefined;
  if (first.operation === "insert" && last.operation === "delete")
    return undefined;
  if (first.operation === "insert")
    return { operation: "insert", after: last.after };
  if (last.operation === "delete")
    return { operation: "delete", before: first.before };
  if (first.operation === "delete" && last.operation === "insert")
    return {
      operation: "replacement",
      before: first.before,
      after: last.after,
    };
  return { operation: "update", before: first.before, after: last.after };
};

const ids = (rows) => rows.map((row) => row.id);

/** One atomic query/version delta: remove named keys, then insert final keyed rows by final index. */
const prefixDelta = (oldPrefix, newPrefix, changedIds) => {
  const changed = new Set(changedIds);
  const oldIds = new Set(ids(oldPrefix));
  const newIds = new Set(ids(newPrefix));
  return {
    removeIds: oldPrefix
      .filter(({ id }) => !newIds.has(id))
      .map(({ id }) => id),
    put: newPrefix.flatMap((row, index) =>
      changed.has(row.id) || !oldIds.has(row.id)
        ? [{ id: row.id, index, row }]
        : [],
    ),
  };
};

const applyPrefixDelta = (oldPrefix, delta) => {
  const removed = new Set([
    ...delta.removeIds,
    ...delta.put.map(({ id }) => id),
  ]);
  const next = oldPrefix.filter(({ id }) => !removed.has(id));
  for (const entry of [...delta.put].sort(
    (left, right) => left.index - right.index,
  ))
    next.splice(entry.index, 0, entry.row);
  return next;
};

test("bounded transition handles inserts, removals, moves, and page-edge displacement", () => {
  const oldRows = new Map(
    Array.from({ length: 8 }, (_, index) => {
      const id = `r${index + 1}`;
      return [id, { id, order: index + 1, matches: true }];
    }),
  );
  const oldPrefix = authoritative(oldRows, 4);
  const currentRows = new Map(oldRows);
  currentRows.set("x", { id: "x", order: 1.5, matches: true });
  currentRows.set("r2", { id: "r2", order: 7.5, matches: true });
  currentRows.set("r3", { id: "r3", order: 3, matches: false });
  assert.deepEqual(
    ids(
      transition({
        oldPrefix,
        currentRows,
        changedIds: ["x", "r2", "r3"],
        limit: 4,
      }),
    ),
    ids(authoritative(currentRows, 4)),
  );
});

test("bounded transition equals a fresh authoritative query across deterministic random batches", () => {
  let seed = 0x51f15e;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let trial = 0; trial < 25_000; trial += 1) {
    const limit = 1 + Math.floor(random() * 12);
    const size = Math.floor(random() * 30);
    const oldRows = new Map();
    for (let index = 0; index < size; index += 1) {
      const id = `r${index}`;
      oldRows.set(id, {
        id,
        order: Math.floor(random() * 20),
        matches: random() > 0.25,
        body: `old-${trial}-${index}`,
      });
    }
    const oldPrefix = authoritative(oldRows, limit);
    const currentRows = new Map(oldRows);
    const changedIds = new Set();
    const changes = 1 + Math.floor(random() * 8);
    for (let change = 0; change < changes; change += 1) {
      const insert = currentRows.size === 0 || random() < 0.25;
      const id = insert
        ? `x${trial}-${change}`
        : [...currentRows.keys()][Math.floor(random() * currentRows.size)];
      changedIds.add(id);
      if (!insert && random() < 0.18) {
        currentRows.delete(id);
      } else {
        currentRows.set(id, {
          id,
          order: Math.floor(random() * 20),
          matches: random() > 0.25,
          body: `new-${trial}-${change}`,
        });
      }
    }
    const newPrefix = authoritative(currentRows, limit);
    assert.deepEqual(
      ids(transition({ oldPrefix, currentRows, changedIds, limit })),
      ids(newPrefix),
      `trial ${trial}`,
    );
    for (const viewerLimit of new Set([
      1,
      Math.max(1, Math.ceil(limit / 2)),
      limit,
    ])) {
      const oldView = oldPrefix.slice(0, viewerLimit);
      const newView = newPrefix.slice(0, viewerLimit);
      assert.deepEqual(
        applyPrefixDelta(oldView, prefixDelta(oldView, newView, changedIds)),
        newView,
        `viewer ${viewerLimit}, trial ${trial}`,
      );
    }
  }
});

test("shared prefixes batch-fetch unchanged bodies that cross a viewer boundary", () => {
  const oldPrefix = Array.from({ length: 20 }, (_, index) => ({
    id: `r${index + 1}`,
    order: index + 1,
    matches: true,
    body: `body-${index + 1}`,
  }));
  const currentRows = new Map(oldPrefix.map((row) => [row.id, row]));
  currentRows.delete("r5");
  currentRows.set("r21", {
    id: "r21",
    order: 21,
    matches: true,
    body: "body-21",
  });
  const newPrefix = authoritative(currentRows, 20);
  const shorterOld = oldPrefix.slice(0, 10);
  const shorterNew = newPrefix.slice(0, 10);
  const delta = prefixDelta(shorterOld, shorterNew, ["r5"]);

  assert.deepEqual(delta.removeIds, ["r5"]);
  assert.deepEqual(
    delta.put.map(({ id }) => id),
    ["r11"],
  );
  assert.deepEqual(applyPrefixDelta(shorterOld, delta), shorterNew);
  assert.equal(
    oldPrefix.some(({ id }) => id === "r11"),
    true,
    "r11 was already a retained key, but the shorter viewer did not hold its body",
  );
});

test("the RFC batch-compaction table preserves first-before and final-after state", () => {
  const a = { route: "old" };
  const b = { route: "middle" };
  const c = { route: "new" };
  assert.deepEqual(
    compact([
      { operation: "insert", after: a },
      { operation: "update", before: a, after: b },
      { operation: "update", before: b, after: c },
    ]),
    { operation: "insert", after: c },
  );
  assert.deepEqual(
    compact([
      { operation: "update", before: a, after: b },
      { operation: "delete", before: b },
    ]),
    { operation: "delete", before: a },
  );
  assert.equal(
    compact([
      { operation: "insert", after: a },
      { operation: "delete", before: a },
    ]),
    undefined,
  );
  assert.deepEqual(
    compact([
      { operation: "delete", before: a },
      { operation: "insert", after: c },
    ]),
    { operation: "replacement", before: a, after: c },
  );
});

const applyFrame = (viewer, frame) => {
  if (viewer.version !== frame.fromVersion) return { ...viewer, reset: true };
  return {
    ...viewer,
    version: frame.toVersion,
    rows: frame.rows ?? viewer.rows,
    reset: false,
  };
};

test("smaller-prefix viewers require empty version frames for larger-prefix-only changes", () => {
  const initial = { version: 0, rows: ["r1", "r2"], reset: false };
  const largerPrefixOnly = { fromVersion: 0, toVersion: 1, rows: undefined };
  const laterVisibleChange = {
    fromVersion: 1,
    toVersion: 2,
    rows: ["x", "r1"],
  };

  const omitted = applyFrame(initial, laterVisibleChange);
  assert.equal(
    omitted.reset,
    true,
    "omitting the no-op frame leaves the viewer version-stale",
  );

  const advanced = applyFrame(
    applyFrame(initial, largerPrefixOnly),
    laterVisibleChange,
  );
  assert.equal(advanced.reset, false);
  assert.deepEqual(advanced.rows, ["x", "r1"]);
});

test("prefix extension attaches at the current version without creating a synthetic version", () => {
  const state = { version: 7, retained: ["r1", "r2"], viewer: ["r1"] };
  const extension = { version: state.version, rows: ["r2"] };
  state.viewer.push(...extension.rows);
  assert.equal(state.version, 7);
  assert.deepEqual(state.viewer, ["r1", "r2"]);

  const commit = { fromVersion: 7, toVersion: 8, rows: ["x", "r1"] };
  const advanced = applyFrame(
    { version: extension.version, rows: state.viewer, reset: false },
    commit,
  );
  assert.equal(advanced.reset, false);
  assert.equal(advanced.version, 8);
});
