/**
 * Prints the SQL one nested `with` read renders to, without executing anything.
 *
 * The point of the script is the second half of its output: it counts the `select`s in the
 * statement — a nested read is one — and shows, for each level, the row-visibility predicate that
 * level carries and whether it appears inside that level's own `left join lateral (…)`. A `with`
 * whose predicate landed anywhere else would be a policy bypass, so the check is worth being able
 * to run by hand.
 *
 *     node scripts/print-rqb-sql.mjs
 *
 * `composer` is a Drizzle instance whose driver dies when called; `toSQL()` never reaches it.
 */
import { createJiti } from 'jiti';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(packageRoot, 'src');

// Both, deliberately. `#lib/*` also resolves through this package's `imports` field, which points at
// `build/` — so without an alias a stale build would answer instead of the sources being examined.
const jiti = createJiti(import.meta.url, {
	alias: { '#lib': sourceRoot },
	tsconfigPaths: true
});

const resolved = jiti.esmResolve('#lib/runtime/collections/relation-query.js');
const resolvedPath = resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved;
if (!resolvedPath.startsWith(sourceRoot + path.sep)) {
	console.error(
		`refusing to run: '#lib/*' resolved to ${resolvedPath}, which is not under ${sourceRoot}.`
	);
	process.exit(1);
}

const { Effect } = await jiti.import('effect');
const { collectionQueryTable, relationalSchema } = await jiti.import(
	'#lib/compiler/relational-schema.js'
);
const { relationalComposer } = await jiti.import('#lib/runtime/persistence.js');
const { orderingExpressions, planRelations } = await jiti.import(
	'#lib/runtime/collections/relation-query.js'
);
const { resolveWritableManyRelation } = await jiti.import(
	'#lib/runtime/collections/collections.js'
);
const { predicateExpression } = await jiti.import('#lib/runtime/access/access-control.js');

const field = (type, extra = {}) => ({ type, required: false, ...extra });

/** The statement with every `left join lateral(…)` cut out: what the root query alone evaluates. */
const rootQueryOnly = (sql) => {
	const opener = 'left join lateral';
	let out = '';
	let index = 0;
	for (;;) {
		const at = sql.indexOf(opener, index);
		if (at === -1) return out + sql.slice(index);
		out += sql.slice(index, at);
		let depth = 0;
		let cursor = at + opener.length;
		for (; cursor < sql.length; cursor += 1) {
			if (sql[cursor] === '(') depth += 1;
			else if (sql[cursor] === ')') {
				depth -= 1;
				if (depth === 0) {
					cursor += 1;
					break;
				}
			}
		}
		const onTrue = sql.indexOf('on true', cursor);
		index = onTrue === -1 ? cursor : onTrue + 'on true'.length;
	}
};

/**
 * Four collections: a parent with children, a child pointing back at its parent, and a row holding
 * a polymorphic reference over two of them.
 *
 * `employment_time_entries` deliberately carries no endpoints of its own — authoring modules put
 * them on the inverse `one` edge — so the emitted relation proves the orientation was resolved
 * rather than assumed.
 */
const definition = {
	name: 'demo',
	version: '0',
	relations: [
		{
			name: 'time_entry_employment',
			source: 'time_entries',
			target: 'employments',
			cardinality: 'one',
			from: { collection: 'time_entries', column: 'employment_id' },
			to: { collection: 'employments', column: 'id' }
		},
		{
			name: 'employment_time_entries',
			source: 'employments',
			target: 'time_entries',
			cardinality: 'many'
		}
	],
	collections: [
		{
			name: 'employments',
			fields: { code: field('string'), active: field('boolean') }
		},
		{
			name: 'time_entries',
			fields: {
				employment_id: field('uuid'),
				work_date: field('date'),
				note: field('string')
			}
		},
		{ name: 'leave_requests', fields: { from_date: field('date') } },
		{
			name: 'payslip_sources',
			fields: {
				source: field('reference', {
					required: true,
					reference: {
						onDelete: 'restrict',
						targets: [
							{
								tag: 'TIME_ENTRY',
								collection: 'time_entries',
								storageColumn: 'source__time_entry_id'
							},
							{
								tag: 'LEAVE_REQUEST',
								collection: 'leave_requests',
								storageColumn: 'source__leave_request_id'
							}
						]
					}
				})
			}
		}
	]
};

const relations = relationalSchema(definition, {
	table: collectionQueryTable,
	resolveMany: resolveWritableManyRelation
});
const composer = relationalComposer(relations);

/** One recognisable row predicate per collection, so each one can be found in the output. */
const predicates = {
	employments: { sql: '"code" = $1', parameters: ['ENG'] },
	time_entries: { sql: '"work_date" >= $1', parameters: ['2026-01-01'] },
	leave_requests: { sql: '"from_date" >= $1', parameters: ['2026-02-02'] },
	payslip_sources: { sql: 'true', parameters: [] }
};
const predicateFor = (collection) => ({
	allowed: true,
	reason: 'demo',
	actorBound: false,
	...(predicates[collection] ?? { sql: 'true', parameters: [] })
});

const context = {
	definition,
	relations,
	authorize: () => Effect.void,
	predicate: predicateFor
};

const render = (label, collection, withSpec) => {
	const planned = Effect.runSync(planRelations(context, collection, withSpec));
	const query = composer.query[collection].findMany({
		where: { RAW: predicateExpression(predicateFor(collection)) },
		orderBy: (table) => [...orderingExpressions(table, [{ column: 'id', direction: 'asc' }])],
		limit: 100,
		...(planned.with === undefined ? {} : { with: planned.with })
	});
	const built = query.toSQL();
	const sql = built.sql;

	console.log(`\n${'='.repeat(78)}\n${label}\n${'='.repeat(78)}`);
	console.log(sql);
	console.log('\nparameters:', JSON.stringify(built.params));
	console.log('statements sent to the database: 1');
	console.log('select keywords in that statement:', sql.match(/\bselect\b/gi)?.length ?? 0);
	console.log('lateral joins:', sql.match(/left join lateral/gi)?.length ?? 0);
	console.log(`\nroot query with every lateral cut out (this one reads ${collection}):`);
	console.log('  ', rootQueryOnly(sql).trim());

	const rootOnly = rootQueryOnly(sql);
	const occurrences = (haystack, needle) => haystack.split(needle).length - 1;
	console.log('\nwhere each collection’s row predicate landed:');
	for (const [name, predicate] of Object.entries(predicates)) {
		if (predicate.sql === 'true') continue;
		const shape = predicate.sql.replace('$1', '').trimEnd();
		const total = occurrences(sql, shape);
		const atRoot = occurrences(rootOnly, shape);
		if (total === 0) continue;
		console.log(
			`  ${name} (${shape} …): ${total} occurrence(s) — ${atRoot} at the root, ${total - atRoot} inside a lateral subquery`
		);
	}
	console.log(
		'  expected: only the read’s own collection appears at the root; every related collection’s predicate is inside a lateral.'
	);
};

render(
	'employments, with their time entries, each with its employment',
	'employments',
	{
		employment_time_entries: {
			columns: { work_date: true },
			limit: 20,
			with: { time_entry_employment: { columns: { code: true } } }
		}
	}
);

render('payslip_sources, with both arms of its polymorphic reference hydrated', 'payslip_sources', {
	source: true
});
