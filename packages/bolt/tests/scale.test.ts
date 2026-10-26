/// <reference types="node" />
// G1 (§11.2): the 120-model scale fixture ported onto the next declarations and
// measured with tsc. Each model carries what makes checking expensive: a state with edges and `edit`, roll-ups over an
// owned inverse, computed trees, relation writes, union/record inputs and inline write/query bodies.
// One literal names index breaks source inference cycles; policies retain masks, previous values and approval callbacks,
// every model has a standalone workflow, and every tenth model also has a scheduled automation.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import { Config, Effect, Option, Schema } from 'effect';
import { splitModel, type RefField } from '../src/decl/model.ts';
import { literal } from '../src/compiler/names.ts';

class ScaleFailed extends Schema.TaggedError<ScaleFailed>()('ScaleFailed', {
	message: Schema.String
}) {}
const sourceFailure = (error: unknown) =>
	new ScaleFailed({ message: error instanceof Error ? error.message : String(error) });
const fixture = Effect.acquireRelease(
	Effect.try({
		try: () => mkdtempSync(join(tmpdir(), 'norbital-g1-scale-')),
		catch: sourceFailure
	}),
	(root) => Effect.sync(() => rmSync(root, { recursive: true, force: true }))
);

// G1's ceiling (§11.2), provisional until J-3(c) re-fixes it. The scale run takes ~30 s, so it runs on `G1_SCALE=1`.
const CEILING = { instantiations: 1_200_000, checkSeconds: 4, memoryKiB: 1024 * 1024 };
let N = 120;

const bolt = fileURLToPath(new URL('..', import.meta.url));
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

const m = (i: number) => `m${((i % N) + N) % N}`;

const modelData = (i: number, typo = false) => {
	const extra: Record<string, RefField> = typo
		? { c: { kind: 'ref', to: 'm1', inverse: 'a_of', optional: true } }
		: {};
	return {
		description: `M${i}`,
		label: typo ? 'nmae' : 'name',
		key: ['name'],
		fields: {
			name: { kind: 'text', max: 120 },
			status: {
				kind: 'state',
				initial: 'draft',
				states: {
					draft: { to: ['open'] },
					open: { to: ['closed', 'draft'], edit: ['status', 'qty', typo ? 'a_off' : 'a_of'] },
					closed: { edit: 'none' }
				}
			},
			qty: { kind: 'decimal', scale: 2 },
			due: { kind: 'date', optional: true },
			tags: { kind: 'text', many: true, optional: true },
			email: { kind: 'text', format: 'email', optional: true },
			total: {
				kind: 'sum',
				of: typo ? 'a_of.qtty' : 'a_of.qty',
				where: { status: { in: ['open', 'closed'] } }
			},
			n_b: { kind: 'count', of: 'b_of' },
			ref: { kind: 'seq', pattern: `M${i}-{0000}`, per: [typo ? 'b_' : 'b'] },
			a: { kind: 'ref', to: m(i + 1), inverse: 'a_of', owned: true },
			b: { kind: 'ref', to: m(i + 7), inverse: 'b_of', optional: true, onDelete: 'setNull' },
			...extra
		},
		search: { text: ['name'] },
		computed: {
			upper: { kind: 'text', expr: { upper: { field: 'name' } } },
			qty_x2: {
				kind: 'decimal',
				expr: { round: [{ times: [{ field: 'qty' }, { field: 'qty' }] }, 2] }
			},
			due_soon: { kind: 'date', expr: { plusDays: [{ field: 'due' }, -7] } }
		},
		check: { named: { name: { ne: '' } } },
		read: 'all',
		create: {
			columns: ['name', 'qty', 'a', 'b', 'due'],
			with: { b_of: { link: {}, unlink: {} } },
			transform: true
		},
		update: {
			columns: ['name', 'status', 'qty', 'b'],
			with: {
				a_of: { create: { columns: ['name', 'qty'] }, update: { columns: ['qty'] }, delete: {} }
			},
			transform: true
		},
		delete: { check: true },
		queries: {
			open: {
				description: 'Open rows',
				input: {
					since: { kind: 'date' },
					pay: {
						kind: 'union',
						by: 't',
						arms: {
							card: { last4: { kind: 'text' } },
							bank: { ref: { kind: 'int', optional: true } }
						}
					},
					split: { kind: 'record', of: { kind: 'decimal', scale: 2 } }
				},
				output: { kind: 'list', of: { kind: 'id', of: m(i) } },
				run: true
			}
		},
		notify: true
	} as const;
};
const modelFile = (i: number, typo = false) => `import { model } from '$BOLT';
const data = ${JSON.stringify(modelData(i, typo))} as const;
export default model('${m(i)}', { ...data,
 create: { ...data.create, transform: function* (rows, ctx) {
  yield* ctx.db.query('${m(i)}', { where: { status: { eq: 'open' } }, limit: 10 });
  return rows;
 } },
 update: { ...data.update, transform: function* (changes) { return changes.map(({ set }) => set); } },
 delete: { check: function* (rows, ctx) { const at = rows.findIndex((row) => row.status === 'closed'); if (at >= 0) yield* ctx.refuse('A closed row stays.', { row: at }); } },
 queries: { open: { ...data.queries.open, run: function* ({ since, pay, split }, ctx) {
  const page = yield* ctx.query('${m(i)}', { where: { status: { eq: 'open' }, due: { gte: since }, a: { is: { upper: { eq: pay.t === 'card' ? pay.last4 : 'X' } } } }, select: { name: true }, limit: Object.keys(split).length });
  return page.rows.map((row) => row.id);
 } } },
 notify: function* () { return [{ title: 'M${i}', to: [{ team: 'T0' }] }]; }
});`;
const workflowData = (i: number) => ({
	description: `Go ${m(i)}`,
	input: {
		target: { kind: 'id', of: m(i) },
		note: { kind: 'text' },
		other: { kind: 'id', of: m(i + 7), where: { status: { eq: 'open' } } }
	},
	output: { kind: 'object', fields: { n: { kind: 'int' } } },
	runAs: 'trigger'
});
const workflowFile = (i: number) => `import { automation } from '$BOLT';
export default automation('${m(i)}_go', { ...${JSON.stringify(workflowData(i))}, run: function* ({ target: targetId, note, other }, ctx) {
 const target = yield* ctx.query('${m(i)}', { id: targetId });
 if (target === null) throw new Error('The target is no longer readable.');
 const far = yield* ctx.query('${m(i + 7)}', { where: { upper: { eq: note + target.name }, qty_x2: { gt: 0 } }, select: { name: true, qty: true, email: true, a: { select: { name: true } }, a_of: { select: { qty: true }, limit: 10 } }, all: true });
 yield* ctx.act('${m(i)}.update', { target: target.id, set: { qty: target.qty } });
 yield* ctx.act('${m(i + 7)}.update', { target: other, set: { name: note } });
 return { n: far.rows.length };
} });`;
const policyData = (i: number) => ({
	description: `P${i}`,
	grants: {
		[m(i)]: {
			read: {
				where: { upper: { eq: 'A' }, total: { gt: 0 } },
				fields: [
					'name',
					'status',
					'qty',
					'due',
					'tags',
					'total',
					'n_b',
					'ref',
					'upper',
					'qty_x2',
					'due_soon',
					'a',
					'b'
				]
			},
			create: { where: 'read', fields: ['name', 'qty', 'a'] },
			update: {
				where: 'read',
				previous: { status: { in: ['draft', 'open'] } },
				fields: ['name', 'status', 'qty', 'a_of']
			},
			delete: { where: { status: { eq: 'draft' } } },
			queries: ['open'],
			moves: { status: ['draft->open'] }
		},
		[m(i + 7)]: { read: { email: { eq: { actor: 'email' } }, qty_x2: { gt: 1 } } }
	},
	automations: [`${m(i)}_go`],
	limits: { act: '10/min' }
});
const policyFile = (i: number) => `import { policy } from '$BOLT';
const data = ${JSON.stringify(policyData(i))} as const;
export default policy({ ...data, grants: { ...data.grants, '${m(i)}': { ...data.grants['${m(i)}'],
 create: { ...data.grants['${m(i)}'].create, approval: (_write, flow) => flow.step('Review', { teams: ['T0'] }) },
 update: { ...data.grants['${m(i)}'].update, approval: (write, flow) => flow.step('Review', { teams: ['T0'] }).if(write.changed.includes('status'), (next) => next.step('Finance', { teams: ['T1'] })) }
} } });`;
const automated = () => Array.from({ length: N }, (_, i) => i).filter((i) => i % 10 === 0);
const automationData = (i: number) => ({
	description: `Chase ${m(i)}`,
	runAs: [`p${i}`],
	on: [
		{ updated: m(i), fields: ['status'], where: { status: { eq: 'open' } } },
		{ cron: '0 2 * * *' }
	]
});
const automationFile = (i: number) => `import { automation } from '$BOLT';
export default automation('a${i}', { ...${JSON.stringify(automationData(i))}, run: function* ({ ids = [] }, ctx) {
 const rows = yield* ctx.query('${m(i)}', { where: { id: { in: ids } }, select: { name: true }, all: true });
 yield* ctx.act('${m(i)}.update', ids.map((id) => ({ target: id, set: { status: 'closed' as const } })));
 yield* ctx.notify({ to: [{ team: 'T0' }], title: String(rows.rows.length) });
} });`;
const namesFile = (typo: boolean) => {
	const parts = Array.from(
		{ length: N },
		(_, i) => [m(i), splitModel(m(i), modelData(i, typo && i === 0))] as const
	);
	const names = {
		workspace: { currency: 'SGD' },
		models: Object.fromEntries(parts.map(([name, p]) => [name, p.model])),
		relationships: Object.assign({}, ...parts.map(([, p]) => p.relationships)),
		collections: Object.fromEntries(
			parts.flatMap(([name, p]) => (p.collection === undefined ? [] : [[name, p.collection]]))
		),
		policies: Object.fromEntries(Array.from({ length: N }, (_, i) => [`p${i}`, policyData(i)])),
		automations: Object.fromEntries([
			...Array.from({ length: N }, (_, i) => [`${m(i)}_go`, { spec: workflowData(i) }]),
			...automated().map((i) => [`a${i}`, { spec: automationData(i) }])
		]),
		teams: { T0: [], T1: [] }
	};
	return `import type { Check, Verify } from '$BOLT';
declare module '$BOLT' { interface Names ${literal(names)} }
export const __verify: Check<Verify> = true;
`;
};

/** Writes the same literal names a tenant sync creates; `typo` plants cross-file declaration mistakes. */
const write = (dir: string, dts: string, typo: boolean) => {
	const files: Record<string, string> = { 'names.ts': namesFile(typo) };
	for (let i = 0; i < N; i++) {
		files[`src/data/model/${m(i)}/+model.ts`] = modelFile(i, typo && i === 0);
		files[`src/access_control/policy/+p${i}.policy.ts`] = policyFile(i);
		files[`src/automation/+${m(i)}_go.automation.ts`] = workflowFile(i);
	}
	for (const i of automated()) files[`src/automation/+a${i}.automation.ts`] = automationFile(i);
	for (const [path, text] of Object.entries(files)) {
		const file = join(dir, path);
		mkdirSync(dirname(file), { recursive: true });
		const source = relative(dirname(file), join(dts, 'index.js'));
		writeFileSync(file, text.replaceAll('$BOLT', source.startsWith('.') ? source : `./${source}`));
	}
	writeFileSync(
		join(dir, 'tsconfig.json'),
		JSON.stringify({ extends: join(bolt, 'tsconfig.json'), include: [], files: Object.keys(files) })
	);
};

const tscRun = (args: readonly string[], cwd: string) =>
	spawnSync(process.execPath, [tsc, ...args], { cwd, encoding: 'utf8', timeout: 120_000 });
/** The emitted declarations of src: a tenant's tsc never checks Bolt's own source. */
const declarations = (root: string) => {
	// Resolve branded values, wire types and the Effects `ctx` answers from the installed packages, just as a tenant does.
	const { resolve } = createRequire(import.meta.url);
	const installed = {
		'@norbital-ai/std': dirname(dirname(resolve('@norbital-ai/std/decimal'))),
		effect: dirname(resolve('effect/package.json'))
	};
	for (const [pkg, dir] of Object.entries(installed)) {
		const link = join(root, 'node_modules', pkg);
		if (existsSync(link)) continue;
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(dir, link, 'dir');
	}
	const dts = join(root, 'dts');
	const config = join(root, 'dts.json');
	writeFileSync(
		config,
		JSON.stringify({
			extends: join(bolt, 'tsconfig.json'),
			include: [join(bolt, 'src/index.ts')],
			compilerOptions: {
				noEmit: false,
				declaration: true,
				emitDeclarationOnly: true,
				rewriteRelativeImportExtensions: true,
				rootDir: join(bolt, 'src'),
				outDir: dts
			}
		})
	);
	const run = tscRun(['-p', config], root);
	if (run.status !== 0) throw new Error(run.stdout);
	return dts;
};

const check = (root: string, n: number, typo: boolean) => {
	N = n;
	const dir = join(root, `${n}-${typo ? 'typo' : 'clean'}`);
	write(dir, declarations(root), typo);
	const run = tscRun(['-p', join(dir, 'tsconfig.json'), '--extendedDiagnostics'], dir);
	const stat = (label: string) =>
		Number(new RegExp(`^${label}:\\s+([\\d.]+)`, 'm').exec(run.stdout)?.[1]);
	return {
		status: run.status,
		out: run.stdout,
		instantiations: stat('Instantiations'),
		memoryKiB: stat('Memory used'),
		checkSeconds: stat('Check time'),
		totalSeconds: stat('Total time')
	};
};

describe('G1 scale fixture', () => {
	it.live(
		'retains branded values in the emitted declaration fixture',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const root = yield* fixture;
					yield* Effect.try({ try: () => declarations(root), catch: sourceFailure });
					const file = join(root, 'brands.ts');
					writeFileSync(
						file,
						`import type { Loose } from './dts/decl/ctx.js';
import type { Decimal, PlainDate, Id } from './dts/index.js';
const text: Loose<string> = 'name';
const decimal: Loose<Decimal> = '1.25';
declare const date: PlainDate;
const validDate: Loose<PlainDate> = date;
declare const id: Id<'m0'>;
const validId: Loose<Id<'m0'>> = id;
// @ts-expect-error numeric text is invalid
const invalidText: Loose<string> = 1;
// @ts-expect-error decimal strings must be numeric
const invalidDecimal: Loose<Decimal> = 'bad';
// @ts-expect-error dates must be branded
const invalidDate: Loose<PlainDate> = 1;
// @ts-expect-error IDs must be branded
const invalidId: Loose<Id<'m0'>> = 'raw';
`
					);
					const config = join(root, 'brands.json');
					writeFileSync(
						config,
						JSON.stringify({ extends: join(bolt, 'tsconfig.json'), include: [], files: [file] })
					);
					const run = tscRun(['-p', config], root);
					expect(run.stdout).toBe('');
					expect(run.status).toBe(0);
				})
			),
		180_000
	);

	// `G1_N` sizes a smaller representative run; the ceiling remains G1's for 120.
	it.live(
		'checks 120 models clean within the ceiling',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const enabled = yield* Config.option(Config.string('G1_SCALE'));
					if (Option.isNone(enabled) || enabled.value === '') return;
					const n = yield* Config.int('G1_N').pipe(Config.withDefault(120)),
						root = yield* fixture;
					const r = yield* Effect.try({ try: () => check(root, n, false), catch: sourceFailure });
					expect(r.out.split('\n').filter((l) => l.includes('error TS'))).toEqual([]);
					expect(r.status).toBe(0);
					console.info(
						`G1 scale (${N} models): ${r.instantiations} instantiations, check ${r.checkSeconds} s, total ${r.totalSeconds} s, ${Math.round(r.memoryKiB / 1024)} MiB`
					);
					expect(r.instantiations).toBeLessThanOrEqual(CEILING.instantiations);
					expect(r.checkSeconds).toBeLessThanOrEqual(CEILING.checkSeconds);
					expect(r.memoryKiB).toBeLessThanOrEqual(CEILING.memoryKiB);
				})
			),
		180_000
	);

	it.live(
		'fails the __verify line with one message per cross-file mistake',
		() =>
			Effect.scoped(
				Effect.gen(function* () {
					const root = yield* fixture;
					const r = yield* Effect.try({ try: () => check(root, 12, true), catch: sourceFailure });
					expect(r.status).not.toBe(0);
					expect(
						r.out.split('\n').filter((l) => l.includes('error TS') && !/(^|\/)names\.ts\(/.test(l))
					).toEqual([]);
					for (const message of [
						"m0: label names unknown field 'nmae'",
						"m0: status.edit names unknown field 'a_off'",
						"m0: total sums unknown field 'qtty'",
						"m0: ref.per names unknown field 'b_'",
						"m1: inverse 'a_of' is declared twice"
					])
						expect(r.out).toContain(message);
				})
			),
		180_000
	);
});
