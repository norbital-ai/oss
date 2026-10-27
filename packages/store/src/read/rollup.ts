/** Combine writers at an instant, then summarize buckets or carry each source's last gauge. */
import { Effect } from 'effect';
import { exposureOf, q, type Catalog } from '../catalog.ts';
import { StoreError } from '../errors.ts';
import type { Pred } from '../ir.ts';
import { STORE_LIMITS } from '../limits.ts';
import { budgeted, Build, pred, RAW, wire } from './sql.ts';

export type RollupIR = {
	readonly table: string;
	readonly by: readonly string[];
	readonly time: string;
	readonly value: string;
	readonly combine?: 'sum' | 'max' | undefined;
	readonly where?: Pred | undefined;
	readonly stepMillis?: number | undefined;
	readonly latestPer?: readonly string[] | undefined;
	readonly carry?:
		{ readonly from: string; readonly until: string; readonly stepMillis: number } | undefined;
};

export const compileRollup = Effect.fn('Store.rollup')(function* (cat: Catalog, query: RollupIR) {
	const c = yield* exposureOf(cat, query.table),
		b = new Build(cat),
		a = b.alias();
	const invalid = (message: string) => Effect.fail(StoreError.of('invalid', 'decode', message));
	const time = c.model.fields.get(query.time),
		value = c.model.fields.get(query.value);
	if (time?.kind !== 'instant' || value?.kind !== 'number')
		return yield* invalid(
			'measurement rollups require an instant and a floating-point number field'
		);
	const names = [...new Set([...query.by, ...(query.latestPer ?? [])])];
	if (query.by.length === 0 || query.by.length > 4 || names.length > 8)
		return yield* invalid('a rollup groups by one to four fields and at most eight source keys');
	const fields = yield* Effect.forEach(names, (name) => {
		const f = c.model.fields.get(name);
		return f === undefined ||
			f.many ||
			['jsonb', 'point', 'vector', 'daterange', 'tstzrange'].includes(f.pg)
			? invalid(`'${name}' is not a scalar rollup key`)
			: Effect.succeed(f);
	});
	const step = query.carry?.stepMillis ?? query.stepMillis;
	if (step !== undefined && (!Number.isSafeInteger(step) || step <= 0))
		return yield* invalid('a rollup step is a positive number of milliseconds');
	if (
		query.carry !== undefined &&
		(query.latestPer === undefined || Date.parse(query.carry.until) < Date.parse(query.carry.from))
	)
		return yield* invalid('a carried rollup requires source keys and an ordered time range');
	if (
		query.carry !== undefined &&
		(Date.parse(query.carry.until) - Date.parse(query.carry.from)) / query.carry.stepMillis >=
			STORE_LIMITS.page.all
	)
		return yield* invalid('a carried rollup exceeds the all-read step budget');
	const group = query.by.map((name) => `readings.${q(name)}`);
	const source = fields.map((f) => `${a}.${q(f.column)} AS ${q(f.name)}`);
	const condition = query.where === undefined ? 'true' : yield* pred(b, c, a, query.where, RAW);
	const T = b.from(c.model.name),
		at = `${a}.${q(time.column)}`,
		amount = `${a}.${q(value.column)}`;
	const dt = step === undefined ? '' : b.bind(step, 'float8');
	const combine = query.combine === 'max' ? 'max' : 'sum';
	const bucket = (x: string) => `floor(extract(epoch FROM ${x}) * 1000 / ${dt}) * ${dt}`;
	let input: string, timestamp: string, total: string, peak: string, latest: string;
	if (query.latestPer !== undefined) {
		const distinct = fields.map((f) => `${a}.${q(f.column)}`);
		const read = (extra: string) =>
			`SELECT DISTINCT ON (${distinct.join(', ')}) ${source.join(', ')}, ${amount} AS "$value" FROM ${T} ${a} WHERE (${condition}) ${extra} ORDER BY ${[...distinct, `${at} DESC`].join(', ')}`;
		if (query.carry === undefined) {
			input = `(${read('')}) readings`;
			timestamp = 'NULL::float8';
		} else {
			const from = b.bind(query.carry.from, 'timestamptz'),
				until = b.bind(query.carry.until, 'timestamptz');
			input = `generate_series(${from}, ${until}, ${dt} * interval '1 millisecond') tick(at) CROSS JOIN LATERAL (${read(`AND ${at} < tick.at + ${dt} * interval '1 millisecond'`)}) readings`;
			timestamp = 'extract(epoch FROM tick.at) * 1000';
		}
		total = peak = latest = `${combine}("$value")`;
	} else {
		input = `(SELECT ${source.join(', ')}, ${at} AS "$time", ${combine}(${amount}) AS "$value" FROM ${T} ${a} WHERE ${condition} GROUP BY ${[...fields.map((f) => `${a}.${q(f.column)}`), at].join(', ')}) readings`;
		timestamp = step === undefined ? 'NULL::float8' : bucket('"$time"');
		total = 'sum("$value")';
		peak = 'max("$value")';
		latest = '(array_agg("$value" ORDER BY "$time" DESC))[1]';
	}
	const grouped = [...group, ...(timestamp === 'NULL::float8' ? [] : [timestamp])];
	const key = query.by.flatMap((name) => {
		const f = fields.find((field) => field.name === name);
		return f === undefined
			? []
			: [b.bind(name, 'text'), wire(f, `readings.${q(name)}`, 'readings')];
	});
	const rows = `SELECT jsonb_build_object('key', jsonb_build_object(${key.join(', ')}), 'at', ${timestamp}, 'peak', ${peak}, 'total', ${total}, 'latest', ${latest}) AS j FROM ${input} GROUP BY ${grouped.join(', ')} ORDER BY ${timestamp === 'NULL::float8' ? group.join(', ') : timestamp} LIMIT ${STORE_LIMITS.page.all + 1}`;
	return yield* b.sql(budgeted(rows, STORE_LIMITS.page.allBytes));
});
