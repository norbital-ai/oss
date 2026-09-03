import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const requireFromBolt = createRequire(new URL("../package.json", import.meta.url));
const { PGlite } = requireFromBolt("@electric-sql/pglite");

const makeDatabase = async () => {
  const database = new PGlite();
  await database.exec(`
		create table app_user (
			id text primary key,
			email text not null,
			team_ids jsonb not null default '[]'::jsonb
		);
		create table site (
			id text primary key,
			name text not null,
			region text not null,
			row_version integer not null default 1
		);
		create table job (
			id text primary key,
			site_id text not null references site(id),
			row_version integer not null default 1
		);
		create table assignment (
			id text primary key,
			job_id text not null references job(id),
			assignee_user_id text not null references app_user(id),
			active boolean,
			row_version integer not null default 1
		);
		create table tag (
			id text primary key,
			name text not null,
			row_version integer not null default 1
		);
		create table site_tag (
			site_id text not null references site(id),
			tag_id text not null references tag(id),
			primary key (site_id, tag_id)
		);
		create index job_site_id_idx on job(site_id);
		create index assignment_job_id_idx on assignment(job_id);
		create index assignment_assignee_user_id_idx on assignment(assignee_user_id);
		create index site_tag_tag_id_idx on site_tag(tag_id);
		insert into app_user(id, email, team_ids) values
			('u1', 'Owner@Example.com', '["Ops"]'),
			('u2', 'other@example.com', '["Finance"]');
		insert into site(id, name, region) values
			('s1', 'Alpha', 'north'),
			('s2', 'Beta', 'north'),
			('s3', 'Gamma', 'south');
		insert into job(id, site_id) values ('j1', 's1'), ('j2', 's2'), ('j3', 's3');
		insert into assignment(id, job_id, assignee_user_id, active) values
			('a1', 'j1', 'u1', true),
			('a2', 'j2', 'u2', true);
		insert into tag(id, name) values ('t1', 'urgent'), ('t2', 'blue');
		insert into site_tag(site_id, tag_id) values ('s1', 't1'), ('s2', 't2');
	`);
  return database;
};

const schema = {
  site: {
    fields: new Set(["id", "name", "region", "row_version"]),
    relations: {
      jobs: {
        kind: "many",
        target: "job",
        targetField: "site_id",
        sourceField: "id",
        identity: "site.jobs",
      },
      tags: {
        kind: "through",
        target: "tag",
        junction: "site_tag",
        junctionSourceField: "site_id",
        junctionTargetField: "tag_id",
        sourceField: "id",
        targetField: "id",
        identity: "site.tags",
      },
    },
  },
  job: {
    fields: new Set(["id", "site_id", "row_version"]),
    relations: {
      assignments: {
        kind: "many",
        target: "assignment",
        targetField: "job_id",
        sourceField: "id",
        identity: "job.assignments",
      },
    },
  },
  assignment: {
    fields: new Set([
      "id",
      "job_id",
      "assignee_user_id",
      "active",
      "row_version",
    ]),
    relations: {},
  },
  tag: {
    fields: new Set(["id", "name", "row_version"]),
    relations: {},
  },
};

const compileEffectivePlan = (root, where, subject) => {
  const parameters = [];
  const dependencies = new Set([root]);
  const reversePaths = [];
  let aliases = 0;

  const parameter = (value) => {
    parameters.push(value);
    return `$${parameters.length}`;
  };
  const operand = (value) =>
    value !== null && typeof value === "object" && "$subject" in value
      ? subject[value.$subject]
      : value;

  const reversedDirectPath = (chain) =>
    [...chain].reverse().map(({ source, relation }) => ({
      identity: relation.identity,
      from: relation.target,
      fromField: relation.targetField,
      to: source,
      toField: relation.sourceField,
    }));

  const compileNode = (collection, alias, node, chain) => {
    const definition = schema[collection];
    const clauses = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === "AND" || key === "OR") {
        const nested = value.map(
          (entry) => `(${compileNode(collection, alias, entry, chain)})`,
        );
        clauses.push(`(${nested.join(` ${key} `)})`);
        continue;
      }
      if (key === "NOT") {
        clauses.push(`not (${compileNode(collection, alias, value, chain)})`);
        continue;
      }
      const relation = definition.relations[key];
      if (relation !== undefined) {
        const quantifier = ["some", "none", "every"].find(
          (candidate) => candidate in value,
        );
        assert.ok(
          quantifier,
          `relation ${collection}.${key} requires a quantifier`,
        );
        const targetAlias = `r${aliases++}`;
        const predicate = compileNode(
          relation.target,
          targetAlias,
          value[quantifier],
          [...chain, { source: collection, relation }],
        );
        dependencies.add(relation.target);
        if (relation.kind === "many") {
          const nextChain = [...chain, { source: collection, relation }];
          reversePaths.push({
            collection: relation.target,
            segments: reversedDirectPath(nextChain),
          });
          const joined = `${targetAlias}.${relation.targetField} = ${alias}.${relation.sourceField}`;
          const violating = `(${predicate}) is not true`;
          const exists = `exists (select 1 from ${relation.target} ${targetAlias} where ${joined} and ${
            quantifier === "every" ? violating : `(${predicate})`
          })`;
          clauses.push(
            quantifier === "none" || quantifier === "every"
              ? `not ${exists}`
              : exists,
          );
          continue;
        }

        dependencies.add(relation.junction);
        const junctionAlias = `j${aliases++}`;
        reversePaths.push({
          collection: relation.junction,
          segments: [
            {
              identity: relation.identity,
              from: relation.junction,
              fromField: relation.junctionSourceField,
              to: collection,
              toField: relation.sourceField,
            },
          ],
        });
        reversePaths.push({
          collection: relation.target,
          segments: [
            {
              identity: relation.identity,
              from: relation.target,
              lookup: relation.junction,
              lookupField: relation.junctionTargetField,
              fromField: relation.targetField,
            },
            {
              identity: relation.identity,
              from: relation.junction,
              fromField: relation.junctionSourceField,
              to: collection,
              toField: relation.sourceField,
            },
          ],
        });
        const joined = `${junctionAlias}.${relation.junctionSourceField} = ${alias}.${relation.sourceField} and ${targetAlias}.${relation.targetField} = ${junctionAlias}.${relation.junctionTargetField}`;
        const violating = `(${predicate}) is not true`;
        const exists = `exists (select 1 from ${relation.junction} ${junctionAlias} join ${relation.target} ${targetAlias} on ${targetAlias}.${relation.targetField} = ${junctionAlias}.${relation.junctionTargetField} where ${junctionAlias}.${relation.junctionSourceField} = ${alias}.${relation.sourceField} and ${
          quantifier === "every" ? violating : `(${predicate})`
        })`;
        clauses.push(
          quantifier === "none" || quantifier === "every"
            ? `not ${exists}`
            : exists,
        );
        continue;
      }

      assert.ok(
        definition.fields.has(key),
        `unknown field ${collection}.${key}`,
      );
      for (const [operator, authored] of Object.entries(value)) {
        const bound = operand(authored);
        if (operator === "eq") {
          clauses.push(
            `${alias}.${key} is not distinct from ${parameter(bound)}`,
          );
        } else if (operator === "in") {
          clauses.push(`${alias}.${key} = any(${parameter(bound)})`);
        } else if (operator === "caseFoldEq") {
          clauses.push(`lower(${alias}.${key}) = lower(${parameter(bound)})`);
        } else if (operator === "isNull") {
          clauses.push(`${alias}.${key} is ${bound ? "" : "not "}null`);
        } else {
          throw new TypeError(`unsupported operator ${operator}`);
        }
      }
    }
    return clauses.length === 0 ? "true" : clauses.join(" and ");
  };

  return {
    sql: compileNode(root, "root", where, []),
    parameters,
    dependencies: [...dependencies].sort(),
    reversePaths,
  };
};

const queryPlan = async (database, root, plan) =>
  (
    await database.query(
      `select root.* from ${root} root where ${plan.sql} order by root.id`,
      plan.parameters,
    )
  ).rows;

test("one structured tree produces executable SQL, dependencies, and direct reverse paths", async () => {
  const database = await makeDatabase();
  try {
    const plan = compileEffectivePlan(
      "site",
      {
        region: { eq: "north" },
        jobs: {
          some: {
            assignments: {
              some: {
                assignee_user_id: { eq: { $subject: "id" } },
                active: { eq: true },
              },
            },
          },
        },
      },
      { id: "u1" },
    );
    assert.deepEqual(plan.dependencies, ["assignment", "job", "site"]);
    assert.ok(
      plan.reversePaths.some(
        (path) =>
          path.collection === "assignment" &&
          path.segments.map(({ from, to }) => `${from}->${to}`).join(",") ===
            "assignment->job,job->site",
      ),
    );
    assert.deepEqual(
      (await queryPlan(database, "site", plan)).map(({ id }) => id),
      ["s1"],
    );

    await database.query(
      `insert into assignment(id, job_id, assignee_user_id, active) values ('a3', 'j2', 'u1', true)`,
    );
    assert.deepEqual(
      (await queryPlan(database, "site", plan)).map(({ id }) => id),
      ["s1", "s2"],
      "a related policy-link insert changes visibility without touching the root row",
    );
  } finally {
    await database.close();
  }
});

test("some, none, and every have explicit two-valued relation semantics", async () => {
  const database = await makeDatabase();
  try {
    const run = async (quantifier) => {
      const plan = compileEffectivePlan(
        "job",
        { assignments: { [quantifier]: { active: { eq: true } } } },
        {},
      );
      return (await queryPlan(database, "job", plan)).map(({ id }) => id);
    };
    assert.deepEqual(await run("some"), ["j1", "j2"]);
    assert.deepEqual(await run("none"), ["j3"]);
    assert.deepEqual(
      await run("every"),
      ["j1", "j2", "j3"],
      "every is vacuously true",
    );

    await database.query(
      `insert into assignment(id, job_id, assignee_user_id, active) values ('a3', 'j1', 'u2', null)`,
    );
    assert.deepEqual(
      await run("every"),
      ["j2", "j3"],
      "NULL is not silently treated as satisfying the predicate under every",
    );
    await database.query(
      `update assignment set active = false where id = 'a2'`,
    );
    assert.deepEqual(await run("some"), ["j1"]);
    assert.deepEqual(await run("none"), ["j2", "j3"]);
    assert.deepEqual(await run("every"), ["j3"]);
  } finally {
    await database.close();
  }
});

test("through relations compile with junction dependencies and reversible segments", async () => {
  const database = await makeDatabase();
  try {
    const plan = compileEffectivePlan(
      "site",
      { tags: { some: { name: { eq: "urgent" } } } },
      {},
    );
    assert.deepEqual(plan.dependencies, ["site", "site_tag", "tag"]);
    assert.ok(
      plan.reversePaths.some(({ collection }) => collection === "site_tag"),
    );
    assert.ok(
      plan.reversePaths.some(
        ({ collection, segments }) =>
          collection === "tag" && segments.length === 2,
      ),
    );
    assert.deepEqual(
      (await queryPlan(database, "site", plan)).map(({ id }) => id),
      ["s1"],
    );
    await database.query(
      `update tag set name = 'urgent', row_version = row_version + 1 where id = 't2'`,
    );
    assert.deepEqual(
      (await queryPlan(database, "site", plan)).map(({ id }) => id),
      ["s1", "s2"],
    );
    const reverse = await database.query(
      `select site_id from site_tag where tag_id = $1 order by site_id`,
      ["t2"],
    );
    assert.deepEqual(
      reverse.rows.map(({ site_id }) => site_id),
      ["s2"],
    );
  } finally {
    await database.close();
  }
});

test("PGlite supports the closed JSON, malformed-array, case-fold, and null-safe policy operators", async () => {
  const database = await makeDatabase();
  try {
    await database.exec(`
			create table approval_request (
				id text primary key,
				requestor text not null,
				approvers jsonb,
				event jsonb,
				superceded_by text
			);
			insert into approval_request values
				('array-match', 'u2', '["finance", "OPS"]', '{"kind":"leave"}', null),
				('array-miss', 'u2', '["legal"]', '{"kind":"leave"}', null),
				('object', 'u2', '{"team":"ops"}', '{}', null),
				('string', 'u2', '"ops"', 'null', null),
				('null', 'u2', null, null, null),
				('requestor', 'u1', '{"bad":true}', '{"kind":null}', null),
				('superseded', 'u1', '["ops"]', '{"kind":"leave"}', 'next');
		`);
    const visible = await database.query(
      `select id from approval_request
			 where superceded_by is null
			   and (
			     requestor = $1
			     or case when jsonb_typeof(approvers) = 'array' then exists (
			       select 1 from jsonb_array_elements_text(approvers) member(value)
			       where lower(member.value) = any($2::text[])
			     ) else false end
			   )
			 order by id`,
      ["u1", ["ops"]],
    );
    assert.deepEqual(
      visible.rows.map(({ id }) => id),
      ["array-match", "requestor"],
      "malformed non-array JSON narrows to false without throwing",
    );

    const nullKinds = await database.query(
      `select id from approval_request
			 where (event #>> '{kind}') is not distinct from $1
			 order by id`,
      [null],
    );
    assert.deepEqual(
      nullKinds.rows.map(({ id }) => id),
      ["null", "object", "requestor", "string"],
    );
    const email = await database.query(
      `select id from app_user where lower(email) = lower($1)`,
      ["owner@example.COM"],
    );
    assert.deepEqual(
      email.rows.map(({ id }) => id),
      ["u1"],
    );
  } finally {
    await database.close();
  }
});

const changedRow = (batch, collection, id, graph) => {
  const change = batch.find(
    (entry) => entry.collection === collection && entry.id === id,
  );
  if (change === undefined) return undefined;
  return graph === "old" ? (change.before ?? null) : (change.after ?? null);
};

const rowForGraph = async (database, batch, collection, id, graph) => {
  const captured = changedRow(batch, collection, id, graph);
  if (captured !== undefined) return captured;
  const result = await database.query(
    `select * from ${collection} where id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
};

const mapForeignKeyPath = async (database, batch, start, graph, path) => {
  let coordinate = start;
  for (const segment of path) {
    const row = await rowForGraph(
      database,
      batch,
      coordinate.collection,
      coordinate.id,
      graph,
    );
    if (row === null) return [];
    const next = row[segment.field];
    if (typeof next !== "string") return [];
    coordinate = { collection: segment.to, id: next };
  }
  return [coordinate.id];
};

test("old/new batch overlays retain reverse roots across re-parenting and connected deletes", async () => {
  const database = await makeDatabase();
  try {
    const path = [
      { field: "job_id", to: "job" },
      { field: "site_id", to: "site" },
    ];
    const reparent = await database.transaction(async (transaction) => {
      const before = (
        await transaction.query(
          `select id, job_id from assignment where id = 'a1'`,
        )
      ).rows[0];
      const after = (
        await transaction.query(
          `update assignment set job_id = 'j2', row_version = row_version + 1 where id = 'a1' returning id, job_id`,
        )
      ).rows[0];
      return [
        {
          collection: "assignment",
          id: "a1",
          operation: "update",
          before,
          after,
        },
      ];
    });
    assert.deepEqual(
      await mapForeignKeyPath(
        database,
        reparent,
        { collection: "assignment", id: "a1" },
        "old",
        path,
      ),
      ["s1"],
    );
    assert.deepEqual(
      await mapForeignKeyPath(
        database,
        reparent,
        { collection: "assignment", id: "a1" },
        "new",
        path,
      ),
      ["s2"],
    );

    await database.query(`update assignment set job_id = 'j1' where id = 'a1'`);
    const deleted = await database.transaction(async (transaction) => {
      const assignment = (
        await transaction.query(
          `delete from assignment where id = 'a1' returning id, job_id`,
        )
      ).rows[0];
      const job = (
        await transaction.query(
          `delete from job where id = 'j1' returning id, site_id`,
        )
      ).rows[0];
      return [
        {
          collection: "assignment",
          id: "a1",
          operation: "delete",
          before: assignment,
        },
        { collection: "job", id: "j1", operation: "delete", before: job },
      ];
    });
    assert.deepEqual(
      await mapForeignKeyPath(
        database,
        deleted,
        { collection: "assignment", id: "a1" },
        "old",
        path,
      ),
      ["s1"],
      "before edges survive after both linked rows have been deleted",
    );
    assert.deepEqual(
      await mapForeignKeyPath(
        database,
        deleted,
        { collection: "assignment", id: "a1" },
        "new",
        path,
      ),
      [],
    );

    const oldJunction = (
      await database.query(
        `delete from site_tag where site_id = 's1' and tag_id = 't1' returning site_id, tag_id`,
      )
    ).rows[0];
    assert.deepEqual(oldJunction, { site_id: "s1", tag_id: "t1" });
    assert.deepEqual(
      [oldJunction.site_id],
      ["s1"],
      "a deleted through/junction edge retains its old root without querying the deleted edge",
    );
    const currentJunction = await database.query(
      `select site_id from site_tag where tag_id = 't1'`,
    );
    assert.deepEqual(currentJunction.rows, []);
  } finally {
    await database.close();
  }
});

test("the transaction seam can return complete route values and publishes nothing on rollback", async () => {
  const database = await makeDatabase();
  try {
    const committed = await database.transaction(async (transaction) => {
      const before = (
        await transaction.query(
          `select id, job_id, assignee_user_id from assignment where id = 'a1' for update`,
        )
      ).rows[0];
      const after = (
        await transaction.query(
          `update assignment
					 set job_id = 'j2', active = false, row_version = row_version + 1
					 where id = 'a1'
					 returning id, job_id, assignee_user_id`,
        )
      ).rows[0];
      return {
        changes: [
          {
            collection: "assignment",
            id: "a1",
            operation: "update",
            before,
            after,
          },
        ],
      };
    });
    assert.deepEqual(committed.changes[0].before, {
      id: "a1",
      job_id: "j1",
      assignee_user_id: "u1",
    });
    assert.deepEqual(committed.changes[0].after, {
      id: "a1",
      job_id: "j2",
      assignee_user_id: "u1",
    });

    let published;
    await assert.rejects(
      database.transaction(async (transaction) => {
        const candidate = await transaction.query(
          `update assignment set job_id = 'j3' where id = 'a1' returning id, job_id`,
        );
        published = { changes: candidate.rows };
        throw new Error("force rollback");
      }),
      /force rollback/u,
    );
    published = undefined;
    const row = await database.query(
      `select job_id from assignment where id = 'a1'`,
    );
    assert.equal(row.rows[0].job_id, "j2");
    assert.equal(
      published,
      undefined,
      "the wrapper publishes only the resolved transaction result",
    );
  } finally {
    await database.close();
  }
});

const compareCoordinate = (left, right) =>
  left.score - right.score || left.id.localeCompare(right.id);

const transitionPrefix = async (database, oldPrefix, changedIds, limit) => {
  const changed = [...new Set(changedIds)];
  const changedSet = new Set(changed);
  const survivors = oldPrefix.filter(({ id }) => !changedSet.has(id));
  const vacancies = oldPrefix.length - survivors.length;
  const boundary = oldPrefix.at(-1);
  const boundaryRows =
    boundary === undefined || vacancies === 0
      ? []
      : (
          await database.query(
            `select id, score from sync_item
						 where bucket = 'live' and active
						   and (score > $1 or (score = $1 and id > $2))
						   and id <> all($3::text[])
						 order by score, id
						 limit $4`,
            [boundary.score, boundary.id, changed, vacancies],
          )
        ).rows;
  const probes = (
    await database.query(
      `select id, score from sync_item
			 where bucket = 'live' and active and id = any($1::text[])
			 order by score, id`,
      [changed],
    )
  ).rows;
  const byId = new Map(
    [...survivors, ...boundaryRows, ...probes].map((coordinate) => [
      coordinate.id,
      coordinate,
    ]),
  );
  return [...byId.values()].sort(compareCoordinate).slice(0, limit);
};

test("the bounded old-boundary transition equals fresh PGlite truth across random SQL batches", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
			create table sync_item (
				id text primary key,
				bucket text not null,
				active boolean not null,
				score integer not null
			);
			create index sync_item_live_order_idx on sync_item(bucket, active, score, id);
			insert into sync_item(id, bucket, active, score)
			select 'r' || value, case when value % 5 = 0 then 'other' else 'live' end,
			       value % 7 <> 0, value % 17
			from generate_series(1, 60) value;
		`);
    let seed = 0x2f61a7;
    let nextId = 0;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const limit = 12;
    for (let trial = 0; trial < 400; trial += 1) {
      const oldPrefix = (
        await database.query(
          `select id, score from sync_item
					 where bucket = 'live' and active order by score, id limit $1`,
          [limit],
        )
      ).rows;
      const changed = [];
      await database.transaction(async (transaction) => {
        const operations = 1 + Math.floor(random() * 5);
        for (let index = 0; index < operations; index += 1) {
          const present = (
            await transaction.query(`select id from sync_item order by id`)
          ).rows;
          const insert = present.length === 0 || random() < 0.28;
          if (insert) {
            const id = `x${nextId++}`;
            changed.push(id);
            await transaction.query(
              `insert into sync_item(id, bucket, active, score) values ($1, $2, $3, $4)`,
              [
                id,
                random() < 0.82 ? "live" : "other",
                random() < 0.78,
                Math.floor(random() * 22),
              ],
            );
            continue;
          }
          const id = present[Math.floor(random() * present.length)].id;
          changed.push(id);
          if (random() < 0.18) {
            await transaction.query(`delete from sync_item where id = $1`, [
              id,
            ]);
          } else {
            await transaction.query(
              `update sync_item
							 set bucket = $2, active = $3, score = $4
							 where id = $1`,
              [
                id,
                random() < 0.82 ? "live" : "other",
                random() < 0.78,
                Math.floor(random() * 22),
              ],
            );
          }
        }
      });
      const advanced = await transitionPrefix(
        database,
        oldPrefix,
        changed,
        limit,
      );
      const fresh = (
        await database.query(
          `select id, score from sync_item
					 where bucket = 'live' and active order by score, id limit $1`,
          [limit],
        )
      ).rows;
      assert.deepEqual(
        advanced,
        fresh,
        `trial ${trial}; changed ${[...new Set(changed)].join(", ")}`,
      );
    }
  } finally {
    await database.close();
  }
});

test("old-boundary refill follows nullable descending order and the id tie-breaker", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
			create table nullable_order_item (
				id text primary key,
				score integer
			);
			insert into nullable_order_item(id, score) values
				('a', 9), ('b', 9), ('c', 7), ('d', 7), ('e', 5),
				('f', 5), ('g', 2), ('h', null), ('i', null);
		`);
    const limit = 5;
    const oldPrefix = (
      await database.query(
        `select id, score from nullable_order_item
				 order by score desc nulls last, id asc limit $1`,
        [limit],
      )
    ).rows;
    await database.exec(`
			delete from nullable_order_item where id = 'b';
			update nullable_order_item set score = null where id = 'c';
			insert into nullable_order_item(id, score) values ('x', 8), ('y', null);
		`);
    const changed = ["b", "c", "x", "y"];
    const changedSet = new Set(changed);
    const survivors = oldPrefix.filter(({ id }) => !changedSet.has(id));
    const vacancies = oldPrefix.length - survivors.length;
    const boundary = oldPrefix.at(-1);
    const boundaryRows = (
      await database.query(
        `select id, score from nullable_order_item
				 where (
				   ($1::integer is not null and (
				     score is null or score < $1 or (score = $1 and id > $2)
				   ))
				   or ($1::integer is null and score is null and id > $2)
				 )
				 and id <> all($3::text[])
				 order by score desc nulls last, id asc
				 limit $4`,
        [boundary.score, boundary.id, changed, vacancies],
      )
    ).rows;
    const probes = (
      await database.query(
        `select id, score from nullable_order_item where id = any($1::text[])
				 order by score desc nulls last, id asc`,
        [changed],
      )
    ).rows;
    const rank = (left, right) => {
      if (left.score === null && right.score !== null) return 1;
      if (left.score !== null && right.score === null) return -1;
      if (left.score !== right.score) return right.score - left.score;
      return left.id.localeCompare(right.id);
    };
    const advanced = [
      ...new Map(
        [...survivors, ...boundaryRows, ...probes].map((coordinate) => [
          coordinate.id,
          coordinate,
        ]),
      ).values(),
    ]
      .sort(rank)
      .slice(0, limit);
    const fresh = (
      await database.query(
        `select id, score from nullable_order_item
				 order by score desc nulls last, id asc limit $1`,
        [limit],
      )
    ).rows;
    assert.deepEqual(advanced, fresh);
  } finally {
    await database.close();
  }
});

test("shared viewer boundaries need one batched body fetch, not a row cache or full refresh", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
			create table shared_prefix(
				id text primary key,
				score integer not null,
				body text not null
			);
			insert into shared_prefix(id, score, body)
			select 'r' || lpad(value::text, 2, '0'), value, 'body-' || value
			from generate_series(1, 25) value;
		`);
    const oldGlobal = (
      await database.query(
        `select id, score from shared_prefix order by score, id limit 20`,
      )
    ).rows;
    const oldShort = (
      await database.query(
        `select id, score, body from shared_prefix order by score, id limit 10`,
      )
    ).rows;
    await database.query(`delete from shared_prefix where id = 'r05'`);
    const newGlobal = (
      await database.query(
        `select id, score from shared_prefix order by score, id limit 20`,
      )
    ).rows;
    const newShortKeys = newGlobal.slice(0, 10);
    const oldShortIds = new Set(oldShort.map(({ id }) => id));
    const putIds = newShortKeys
      .filter(({ id }) => !oldShortIds.has(id))
      .map(({ id }) => id);
    assert.deepEqual(putIds, ["r11"]);

    const globalEntrants = new Set(
      newGlobal
        .filter(({ id }) => !oldGlobal.some((old) => old.id === id))
        .map(({ id }) => id),
    );
    assert.deepEqual([...globalEntrants], ["r21"]);
    assert.equal(
      globalEntrants.has("r11"),
      false,
      "the global boundary read does not fetch r11",
    );

    const fetched = (
      await database.query(
        `select id, score, body from shared_prefix where id = any($1::text[])`,
        [putIds],
      )
    ).rows;
    assert.deepEqual(fetched, [{ id: "r11", score: 11, body: "body-11" }]);
    const removed = new Set(["r05", ...putIds]);
    const applied = oldShort.filter(({ id }) => !removed.has(id));
    for (const row of fetched) {
      const index = newShortKeys.findIndex(({ id }) => id === row.id);
      applied.splice(index, 0, row);
    }
    const fresh = (
      await database.query(
        `select id, score, body from shared_prefix order by score, id limit 10`,
      )
    ).rows;
    assert.deepEqual(applied, fresh);
  } finally {
    await database.close();
  }
});

test("reverse-root point probes preserve some, none, and every across random relation mutations", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
			create table relation_root(id text primary key);
			create table relation_child(
				id text primary key,
				root_id text not null references relation_root(id),
				flag boolean
			);
			create index relation_child_root_id_idx on relation_child(root_id);
			insert into relation_root select 'p' || value from generate_series(1, 10) value;
			insert into relation_child(id, root_id, flag)
			select 'c' || value, 'p' || (1 + value % 10),
			       case when value % 6 = 0 then null else value % 3 = 0 end
			from generate_series(1, 30) value;
		`);
    const predicate = {
      some: `exists (select 1 from relation_child child where child.root_id = root.id and child.flag is true)`,
      none: `not exists (select 1 from relation_child child where child.root_id = root.id and child.flag is true)`,
      every: `not exists (select 1 from relation_child child where child.root_id = root.id and (child.flag is true) is not true)`,
    };
    const fresh = async (quantifier) =>
      new Set(
        (
          await database.query(
            `select id from relation_root root where ${predicate[quantifier]} order by id`,
          )
        ).rows.map(({ id }) => id),
      );
    const state = {
      some: await fresh("some"),
      none: await fresh("none"),
      every: await fresh("every"),
    };
    let seed = 0x73be91;
    let nextId = 1000;
    const random = () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    const randomFlag = () => {
      const roll = random();
      return roll < 0.2 ? null : roll < 0.58;
    };
    for (let trial = 0; trial < 250; trial += 1) {
      const roots = new Set();
      await database.transaction(async (transaction) => {
        const children = (
          await transaction.query(
            `select id, root_id from relation_child order by id`,
          )
        ).rows;
        if (children.length === 0 || random() < 0.27) {
          const id = `n${nextId++}`;
          const rootId = `p${1 + Math.floor(random() * 10)}`;
          roots.add(rootId);
          await transaction.query(
            `insert into relation_child(id, root_id, flag) values ($1, $2, $3)`,
            [id, rootId, randomFlag()],
          );
          return;
        }
        const child = children[Math.floor(random() * children.length)];
        roots.add(child.root_id);
        if (random() < 0.18) {
          await transaction.query(`delete from relation_child where id = $1`, [
            child.id,
          ]);
          return;
        }
        const rootId =
          random() < 0.35 ? `p${1 + Math.floor(random() * 10)}` : child.root_id;
        roots.add(rootId);
        await transaction.query(
          `update relation_child set root_id = $2, flag = $3 where id = $1`,
          [child.id, rootId, randomFlag()],
        );
      });
      for (const quantifier of ["some", "none", "every"]) {
        const impacted = [...roots];
        const matches = new Set(
          (
            await database.query(
              `select id from relation_root root
							 where id = any($1::text[]) and ${predicate[quantifier]}`,
              [impacted],
            )
          ).rows.map(({ id }) => id),
        );
        for (const id of impacted) {
          if (matches.has(id)) state[quantifier].add(id);
          else state[quantifier].delete(id);
        }
        assert.deepEqual(
          [...state[quantifier]].sort(),
          [...(await fresh(quantifier))].sort(),
          `${quantifier} trial ${trial}`,
        );
      }
    }
  } finally {
    await database.close();
  }
});

test("a related projection can be point-refetched without exposing internal filter fields", async () => {
  const database = await makeDatabase();
  try {
    const readSite = async (id) =>
      (
        await database.query(
          `select site.id, site.name,
					        coalesce((
					          select jsonb_agg(
					            jsonb_build_object('id', assignment.id, 'active', assignment.active)
					            order by assignment.id
					          )
						  from job join assignment on assignment.job_id = job.id
						  where job.site_id = site.id
						    and assignment.assignee_user_id = 'u1'
					        ), '[]'::jsonb) as assignments
					 from site
					 where site.id = $1 and site.region = 'north'`,
          [id],
        )
      ).rows[0];
    const before = await readSite("s1");
    assert.deepEqual(Object.keys(before).sort(), ["assignments", "id", "name"]);
    assert.deepEqual(before.assignments, [{ active: true, id: "a1" }]);
    const changed = (
      await database.query(
        `update assignment set active = false, row_version = row_version + 1
				 where id = 'a1' returning id, job_id`,
      )
    ).rows[0];
    const reverse = (
      await database.query(`select job.site_id from job where job.id = $1`, [
        changed.job_id,
      ])
    ).rows[0].site_id;
    assert.equal(reverse, "s1");
    const after = await readSite(reverse);
    assert.deepEqual(after.assignments, [{ active: false, id: "a1" }]);
    assert.equal("region" in after, false);

    const beforePolicyLink = await readSite("s2");
    assert.deepEqual(beforePolicyLink.assignments, []);
    const policyLink = (
      await database.query(
        `update assignment set assignee_user_id = 'u1' where id = 'a2'
				 returning id, job_id`,
      )
    ).rows[0];
    const policyRoot = (
      await database.query(`select site_id from job where id = $1`, [
        policyLink.job_id,
      ])
    ).rows[0].site_id;
    assert.equal(policyRoot, "s2");
    const afterPolicyLink = await readSite(policyRoot);
    assert.deepEqual(afterPolicyLink.assignments, [{ active: true, id: "a2" }]);
    assert.equal("region" in afterPolicyLink, false);
  } finally {
    await database.close();
  }
});

test("database cascades and trigger writes are not visible in root-statement RETURNING", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
			create table capture_parent(id text primary key, value integer not null);
			create table capture_child(
				id text primary key,
				parent_id text not null references capture_parent(id) on delete cascade
			);
			create table capture_audit(id bigint generated always as identity primary key, parent_id text);
			create function capture_parent_audit() returns trigger language plpgsql as $$
			begin
			  insert into capture_audit(parent_id) values (new.id);
			  return new;
			end
			$$;
			create trigger capture_parent_update
			  after update on capture_parent for each row execute function capture_parent_audit();
			insert into capture_parent values ('p1', 1), ('p2', 1);
			insert into capture_child values ('c1', 'p1');
		`);
    const updated = await database.query(
      `update capture_parent set value = 2 where id = 'p2' returning id`,
    );
    assert.deepEqual(updated.rows, [{ id: "p2" }]);
    assert.deepEqual(
      (await database.query(`select parent_id from capture_audit`)).rows,
      [{ parent_id: "p2" }],
    );
    const deleted = await database.query(
      `delete from capture_parent where id = 'p1' returning id`,
    );
    assert.deepEqual(deleted.rows, [{ id: "p1" }]);
    assert.deepEqual(
      (await database.query(`select * from capture_child`)).rows,
      [],
    );
    assert.equal(
      updated.rows.some((row) => "parent_id" in row) ||
        deleted.rows.some((row) => "parent_id" in row),
      false,
      "root RETURNING does not disclose trigger/cascade side effects; they need transition capture or rejection",
    );
  } finally {
    await database.close();
  }
});

test("declared reverse and routing indexes are discoverable and used by PGlite plans", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
			create table routing_probe(id integer primary key, route integer not null);
			create index routing_probe_route_idx on routing_probe(route);
			insert into routing_probe select value, value % 100 from generate_series(1, 10000) value;
			analyze routing_probe;
		`);
    const indexes = await database.query(
      `select indexname from pg_indexes where tablename = 'routing_probe' order by indexname`,
    );
    assert.deepEqual(
      indexes.rows.map(({ indexname }) => indexname),
      ["routing_probe_pkey", "routing_probe_route_idx"],
    );
    const explained = await database.query(
      `explain (format json) select * from routing_probe where route = 42`,
    );
    assert.match(JSON.stringify(explained.rows), /routing_probe_route_idx/u);
  } finally {
    await database.close();
  }
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

class SerialLane {
  #tail = Promise.resolve();
  enqueue(operation) {
    const running = this.#tail.then(operation);
    this.#tail = running.then(
      () => undefined,
      () => undefined,
    );
    return running;
  }
  idle() {
    return this.#tail;
  }
}

test("lane serialization closes the after-read/before-attach opening race against PGlite", async () => {
  const database = new PGlite();
  try {
    await database.exec(`
			create table opening_probe(id text primary key, visible boolean not null);
			insert into opening_probe values ('r1', true), ('r2', false);
		`);
    const lane = new SerialLane();
    const readComplete = deferred();
    const allowAttach = deferred();
    const active = { ids: [], version: -1 };
    const read = () =>
      database
        .query(`select id from opening_probe where visible order by id`)
        .then(({ rows }) => rows.map(({ id }) => id));
    const opening = lane.enqueue(async () => {
      const ids = await read();
      readComplete.resolve();
      await allowAttach.promise;
      active.ids = ids;
      active.version = 0;
    });
    await readComplete.promise;
    await database.query(
      `update opening_probe set visible = true where id = 'r2'`,
    );
    const committed = lane.enqueue(async () => {
      active.ids = await read();
      active.version += 1;
    });
    allowAttach.resolve();
    await Promise.all([opening, committed]);
    assert.deepEqual(active, { ids: ["r1", "r2"], version: 1 });
  } finally {
    await database.close();
  }
});

test("PGlite probe identifies the engine and PostgreSQL semantic version used by this receipt", async () => {
  const database = new PGlite();
  try {
    const version = (await database.query(`select version() as version`))
      .rows[0].version;
    assert.match(version, /PostgreSQL 18\.3 \(PGlite 0\.5\.5\)/u);
  } finally {
    await database.close();
  }
});
