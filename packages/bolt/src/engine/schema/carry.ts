// `HostApi.schema.carry`: an author's `migrations/` set on top of live's. History is linear, so the author's migrations
// go on top of live's. A merged migration has run on live: it stays byte for byte. The author's own are written again
// from live's schema as it stands (a table's history schema, say, follows every column on it), and what the author wrote
// by hand the host carries across by a three-way merge against what the generator wrote them. Where a step's meaning
// moved, the step names why it stops for the author.
import { Effect, Option, Predicate } from 'effect';
import type { CarriedMigration, MigrationCarry } from '@norbital-ai/host-api';
import {
	canonical,
	generate,
	read_lock,
	read_snapshot,
	sha256_hex,
	snapshot_of,
	type SchemaSpec
} from '@norbital-ai/store';
import { migration_objects } from './migrations.ts';

const MIGRATIONS = 'migrations';
const SNAPSHOT = `${MIGRATIONS}/snapshot.json`;
const LOCK = `${MIGRATIONS}/migrations.lock.json`;
const SQL = /^migrations\/(\d{4})_([a-z0-9_]+)\.sql$/;
/** A generated file's first line: the schema it arrives at. */
const ARRIVES = /^-- \S+: \d+ step\(s\), from .* to ([0-9a-f]{64})\.$/m;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const fileName = (path: string) => path.split('/').at(-1) ?? path;
const renumbered = (path: string, number: number) =>
	`${MIGRATIONS}/${String(number).padStart(4, '0')}${fileName(path).slice(4)}`;

/** Whether `at` (the spec, `tables`, a table, its `fields`) merges key by key; a field, or any other key, is one decision. */
const opens = (at: readonly string[]) =>
	at.length === 0 ||
	(at[0] === 'tables' && (at.length < 3 || (at.length === 3 && at[2] === 'fields')));
/** The schema with both sides' changes, down to one field; one both sides changed joins `both`, and live's stands. */
const threeWay = (
	base: unknown,
	live: unknown,
	mine: unknown,
	at: readonly string[],
	both: string[]
): unknown => {
	if (same(base, mine)) return live;
	if (same(base, live)) return mine;
	if (opens(at) && Predicate.isObject(live) && Predicate.isObject(mine)) {
		const from = Predicate.isObject(base) ? base : {};
		return Object.fromEntries(
			[...new Set([...Object.keys(live), ...Object.keys(mine)])].flatMap((key) => {
				const value = threeWay(from[key], live[key], mine[key], [...at, key], both);
				return value === undefined ? [] : [[key, value]];
			})
		);
	}
	// the same change on both sides is no clash, unless it is a column: a step that adds one means something else now
	if (at[2] === 'fields' || !same(live, mine))
		both.push(
			at
				.filter((key, index) => (index === 2 ? key !== 'fields' : index > 0 || key !== 'tables'))
				.join('.')
		);
	return live;
};
/** Each table or field live moved since the author left it. */
const movedOn = (
	base: SchemaSpec,
	live: SchemaSpec
): ReadonlyArray<{ table: string; field?: string; name: string }> =>
	Object.keys({ ...base.tables, ...live.tables }).flatMap((table) => {
		const [was, now] = [base.tables[table], live.tables[table]];
		if (was === undefined || now === undefined)
			return same(was, now) ? [] : [{ table, name: table }];
		return Object.keys({ ...was.fields, ...now.fields })
			.filter((field) => !same(was.fields[field], now.fields[field]))
			.map((field) => ({ table, field, name: `${table}.${field}` }));
	});
const mentions = (sql: string, word: string) => new RegExp(`\\b${word}\\b`).test(sql);
/** The executed lines of `file` no generator wrote. */
const handWritten = (file: string, generated: string) => {
	const known = new Set(generated.split('\n'));
	return file
		.split('\n')
		.filter((line) => line.trim() !== '' && !line.startsWith('--') && !known.has(line))
		.join('\n');
};
/** As a Studio build leaves a generated file (`BOLT_ACCEPT_DESTRUCTIVE`): its merge approval accepts these steps. */
const accepted = (sql: string) =>
	sql.replace(/^-- step (\S+) \(destructive\)\s*$/gm, '$&\n-- accept: $1');
const generated = (before: SchemaSpec, after: SchemaSpec, number: number, name: string) =>
	read_snapshot(snapshot_of(before)).pipe(
		Effect.flatMap((previous) => generate(previous, after, { number, name }, migration_objects)),
		Effect.map(({ file }) => accepted(file.sql))
	);

/**
 * The author's migrations on top of `live`. A generated file's header names the schema it arrives at, and the line's
 * snapshots hold that schema. A file with no such schema (by hand, or the first of two generations in one commit)
 * carries as it stands, and the build's proof decides.
 */
export const carry_migrations = ({ base, live, line }: MigrationCarry) =>
	Effect.gen(function* () {
		const head = line.at(-1) ?? {},
			own = Object.keys(head)
				.filter((path) => SQL.test(path) && base[path] === undefined)
				.sort(),
			steps: CarriedMigration[] = [];
		if (own.length === 0) return steps;
		const liveSchema = (yield* read_snapshot(live[SNAPSHOT] ?? '')).schema,
			snapshots = new Map<string, Readonly<{ schema: SchemaSpec; at: number }>>();
		for (const [at, files] of line.entries()) {
			const snapshot = yield* Effect.option(read_snapshot(files[SNAPSHOT] ?? ''));
			if (Option.isNone(snapshot)) continue;
			const key = snapshot.value.fingerprint;
			if (!snapshots.has(key)) snapshots.set(key, { schema: snapshot.value.schema, at });
		}
		const liveLock = yield* read_lock(live[LOCK] ?? '');
		let from = (yield* read_snapshot(base[SNAPSHOT] ?? '')).schema,
			merged = liveSchema,
			number = Object.keys(liveLock.files).length;
		const moved = movedOn(from, liveSchema);
		for (const path of own) {
			number += 1;
			const [, digits = '', slug = ''] = SQL.exec(path) ?? [],
				target = renumbered(path, number),
				mine = head[path] ?? '',
				known = snapshots.get(ARRIVES.exec(mine)?.[1] ?? ''),
				to = known?.schema ?? from,
				both: string[] = [],
				next = (yield* read_snapshot(JSON.stringify(threeWay(from, merged, to, [], both)))).schema,
				regenerates = !same(from, to),
				written = regenerates ? yield* generated(from, to, Number(digits), slug) : '',
				file = !regenerates
					? { text: mine.replace(fileName(path), fileName(target)) }
					: mine === written
						? { text: yield* generated(merged, next, number, slug) }
						: {
								merge: {
									base: written,
									ours: yield* generated(merged, next, number, slug),
									theirs: mine
								}
							},
				hand = handWritten(mine, written),
				snapshot = snapshot_of(next);
			steps.push({
				path,
				target,
				...file,
				clashes: [
					...both.map(
						(name) => `Live changed ${name} after your work started, and your work changes it too.`
					),
					...moved
						.filter(
							({ table, field }) =>
								mentions(hand, table) && (field === undefined || mentions(hand, field))
						)
						.map(
							({ name }) => `Your data step uses ${name}, which changed on live after your work started.`
						)
				],
				snapshot,
				// the build plans from the snapshot its lock names: live's proofs stay, now over the carried snapshot
				lock: `${JSON.stringify({ ...liveLock, snapshot: sha256_hex(snapshot) }, null, '\t')}\n`,
				at: known?.at ?? line.findIndex((files) => files[path] !== undefined)
			});
			from = to;
			merged = next;
		}
		return steps;
	});
