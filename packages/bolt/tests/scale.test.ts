/// <reference types="node" />
// G1 (§11.2): the 120-model scale fixture ported onto the next declarations and
// measured with tsc. Each model carries what makes checking expensive: a state with edges and `edit`, roll-ups over an
// owned inverse, computed trees, a collection with relation actions, union/record inputs, a transform, a query and a
// record action whose bodies read with `select` and `Paged` arms and write with `act`, a policy with a masked field,
// `previous`, ordered approval routes and moves, and every tenth model an automation.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@effect/vitest';
import { Config, Effect, Option, Schema } from 'effect';

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

const modelFile = (i: number, typo = false) => `import { model } from '${'$'}BOLT';
export default model({
	description: 'M${i}', label: '${typo ? 'nmae' : 'name'}', key: ['name'],
	fields: {
		name: { kind: 'text', max: 120 },
		status: { kind: 'state', initial: 'draft', states: {
			draft: { to: ['open'] }, open: { to: ['closed', 'draft'], edit: ['status', 'qty', '${typo ? 'a_off' : 'a_of'}'] }, closed: { edit: 'none' } } },
		qty: { kind: 'decimal', scale: 2 },
		due: { kind: 'date', optional: true },
		tags: { kind: 'text', many: true, optional: true },
		email: { kind: 'text', format: 'email', optional: true },
		total: { kind: 'sum', of: '${typo ? 'a_of.qtty' : 'a_of.qty'}', where: { status: { in: ['open', 'closed'] } } },
		n_b: { kind: 'count', of: 'b_of' },
		ref: { kind: 'seq', pattern: 'M${i}-{0000}', per: ['${typo ? 'b_' : 'b'}'] },
	},
	search: { text: ['name'] },
	computed: {
		upper: { kind: 'text', expr: { upper: { field: 'name' } } },
		qty_x2: { kind: 'decimal', expr: { round: [{ times: [{ field: 'qty' }, { field: 'qty' }] }, 2] } },
		due_soon: { kind: 'date', expr: { plusDays: [{ field: 'due' }, -7] } },
	},
	check: { named: { name: { ne: '' } } },
});
`;

const collectionFile = (i: number) => `import { Effect } from 'effect';
import { collection } from '${'$'}BOLT';
const c = collection('${m(i)}', {
	read: { fields: 'all' },
	create: { input: { columns: ['name', 'qty', 'a', 'b', 'due'], with: { b_of: { link: {}, unlink: {} } } } },
	update: { input: { columns: ['name', 'status', 'qty', 'b'], with: { a_of: { create: { columns: ['name', 'qty'] }, update: { columns: ['qty'] }, delete: {} } } } },
	delete: { transform: true },
	queries: { open: { description: 'Open rows', input: { since: { kind: 'date' },
		pay: { kind: 'union', by: 't', arms: { card: { last4: { kind: 'text' } }, bank: { ref: { kind: 'int', optional: true } } } },
		split: { kind: 'record', of: { kind: 'decimal', scale: 2 } } }, output: { kind: 'list', of: { kind: 'id', of: '${m(i)}' } } } },
	actions: { go: { description: 'Go', target: 'record', input: { note: { kind: 'text' }, other: { kind: 'id', of: '${m(i + 7)}', where: { status: { eq: 'open' } } } },
		output: { kind: 'object', fields: { n: { kind: 'int' } } } } },
	notifications: { approvalStepRequested: [{ channel: 'inbox', to: ['step_approvers', { team: 'T0' }], title: 'M${i}' }] },
});
c.transform(function* (inputs, ctx) {
	const siblings = yield* ctx.db.read('${m(i)}', { where: { status: { eq: 'open' } }, limit: 10 });
	if (inputs.some((input, k) => '$delete' in input && ctx.existing[k]?.status === 'closed')) return yield* ctx.refuse('A closed row stays.');
	return inputs.map((input, k) => '$delete' in input || input.name !== undefined ? input : { ...input, name: ctx.existing[k]?.name ?? String(siblings.rows.length) });
});
c.query('open', function* ({ since, pay, split }, ctx) {
	const page = yield* ctx.read('${m(i)}', { where: { status: { eq: 'open' }, due: { gte: since }, a: { is: { upper: { eq: pay.t === 'card' ? pay.last4 : 'X' } } } },
		select: { name: true }, limit: Object.keys(split).length });
	return page.rows.map((r) => r.id);
});
c.action('go', function* ({ note, other }, ctx) {
	const far = yield* ctx.read('${m(i + 7)}', { where: { upper: { eq: note + ctx.target.name }, qty_x2: { gt: 0 }, a_of: { some: { status: { eq: 'open' } } } },
		select: { name: true, qty: true, email: true, a: { select: { name: true } }, a_of: { select: { qty: true }, limit: 10 } }, all: true });
	yield* ctx.act('${m(i)}.update', { target: ctx.target.id, set: { qty: ctx.target.qty, a_of: { create: [{ name: note, qty: ctx.target.qty }] } } });
	yield* ctx.act('${m(i + 7)}.update', { target: other, set: { name: note } });
	const made = yield* ctx.act('${m(i)}.upsert', { name: note, qty: ctx.target.qty, a: ctx.target.a }, { onConflict: 'update' }).pipe(Effect.orElseSucceed(() => null)); // hook:ctx-types (rule 28)
	return { n: far.rows.length + (made?.kind === 'committed' ? made.records.length : 0) };
});
export default c;
`;

const policyFile = (i: number) => `import { policy } from '${'$'}BOLT';
export default policy({ description: 'P${i}', grants: {
	${m(i)}: {
		read: { where: { upper: { eq: 'A' }, total: { gt: 0 } },
			fields: ['name', 'status', 'qty', 'due', 'tags', 'total', 'n_b', 'ref', 'upper', 'qty_x2', 'due_soon', 'a', 'b'] },
		create: { where: 'read', fields: ['name', 'qty', 'a'] },
		update: { where: 'read', previous: { status: { in: ['draft', 'open'] } }, fields: ['name', 'status', 'qty', 'a_of'] },
		approval: { create: { match: { record: { qty: { gt: 100 } } }, steps: [['T0']] },
			update: [{ match: { previous: { status: { eq: 'draft' } }, changed: ['status'], requestor: 'in_team' }, steps: [['T0'], ['T1']] }, { steps: [['T1']] }] },
		delete: { status: { eq: 'draft' } },
		queries: ['open'], actions: ['go'], moves: { status: ['draft->open'] },
	},
	${m(i + 7)}: { read: { email: { eq: { actor: 'email' } }, qty_x2: { gt: 1 } } },
}, limits: { '${m(i)}.go': '10/min' } });
`;

const automationFile = (i: number) => `import { automation } from '${'$'}BOLT';
const a = automation({ description: 'Chase ${m(i)}', runAs: ['p${i}'],
	on: [{ updated: '${m(i)}', fields: ['status'], where: { status: { eq: 'open' } } }, { cron: '0 2 * * *' }] });
a.run(function* ({ ids = [] }, ctx) {
	const rows = yield* ctx.read('${m(i)}', { where: { id: { in: ids } }, select: { name: true }, all: true });
	yield* ctx.act('${m(i)}.update', ids.map((id) => ({ target: id, set: { status: 'closed' as const } })));
	yield* ctx.notify({ to: { team: 'T0' }, title: String(rows.rows.length) });
});
export default a;
`;

const relationshipsFile = (typo: boolean) => `import { relationship } from '${'$'}BOLT';
export default relationship({${typo ? `\n\t'm0.c': { to: 'm1', inverse: 'a_of', optional: true },` : ''}
${Array.from(
	{ length: N },
	(_, i) => `\t'${m(i)}.a': { to: '${m(i + 1)}', inverse: 'a_of', owned: true },
	'${m(i)}.b': { to: '${m(i + 7)}', inverse: 'b_of', optional: true, onDelete: 'setNull' },`
).join('\n')}
});
`;

const automated = () => Array.from({ length: N }, (_, i) => i).filter((i) => i % 10 === 0);
const namesFile = () => `import type { Check, Verify } from '${'$'}BOLT';
declare module '${'$'}BOLT' {
	interface Names {
		workspace: { currency: 'SGD' };
		models: {
${Array.from({ length: N }, (_, i) => `\t\t\t${m(i)}: typeof import('./models/${m(i)}.ts').default;`).join('\n')}
		};
		relationships: typeof import('./relationships.ts').default;
		collections: {
${Array.from({ length: N }, (_, i) => `\t\t\t${m(i)}: typeof import('./collections/${m(i)}.ts').default;`).join('\n')}
		};
		policies: {
${Array.from({ length: N }, (_, i) => `\t\t\tp${i}: typeof import('./policies/p${i}.ts').default;`).join('\n')}
		};
		automations: {
${automated()
	.map((i) => `\t\t\ta${i}: typeof import('./automations/a${i}.ts').default;`)
	.join('\n')}
		};
		teams: { T0: unknown; T1: unknown };
	}
}
export const __verify: Check<Verify> = true;
`;

/** Writes the workspace against `dts` (Bolt as a tenant sees it); `typo` plants five `__verify` mistakes. */
const write = (dir: string, dts: string, typo: boolean) => {
	const files: Record<string, string> = {
		'names.ts': namesFile(),
		'relationships.ts': relationshipsFile(typo)
	};
	for (let i = 0; i < N; i++) {
		files[`models/${m(i)}.ts`] = modelFile(i, typo && i === 0);
		files[`collections/${m(i)}.ts`] = collectionFile(i);
		files[`policies/p${i}.ts`] = policyFile(i);
	}
	for (const i of automated()) files[`automations/a${i}.ts`] = automationFile(i);
	for (const [path, text] of Object.entries(files)) {
		const file = join(dir, path);
		mkdirSync(join(file, '..'), { recursive: true });
		const src = relative(join(file, '..'), join(dts, 'index.js'));
		writeFileSync(file, text.replaceAll('$BOLT', src.startsWith('.') ? src : `./${src}`));
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
