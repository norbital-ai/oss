/**
 * Every ported rule, with source that must be reported and source that must not.
 *
 * This is the port's acceptance criterion. The legacy detector's rules were visitors whose
 * behaviour was asserted only indirectly, which is how `QRY1` came to match variable names for
 * years without anybody noticing. A rule that cannot demonstrate both halves here is not ported.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
	boundaryRules,
	effectRules,
	platformRules,
	runRules,
	structureRules,
	svelteRules,
	type Rule
} from '../build/index.js';

const ALL: ReadonlyArray<Rule> = [
	...boundaryRules,
	...effectRules,
	...structureRules,
	...platformRules,
	...svelteRules
];

/** Effect-owned by default: several rules only apply where Effect is imported. */
const PRELUDE = "import { Effect } from 'effect';\n";

type Case = Readonly<{
	rule: string;
	bad: string;
	good: string;
	file?: string;
	/** Extra repository files a rule needs in order to mean anything — a tsconfig, a manifest. */
	fixture?: Readonly<Record<string, string>>;
}>;

const CASES: ReadonlyArray<Case> = [
	// --- typed boundaries -------------------------------------------------------------------
	{
		rule: 'R1',
		bad: 'export function f(v: any) { return v; }',
		good: 'export function f(v: unknown) { return v; }'
	},
	{
		rule: 'R3a',
		bad: 'export const b = v as Record<string, unknown>;',
		good: 'export const b = decode(v);'
	},
	{
		rule: 'R3b',
		bad: "export const n = 'a' as unknown as number;",
		good: "export const n = Number('a');"
	},
	{ rule: 'R3e', bad: 'export const o = v as unknown;', good: 'export const o: unknown = v;' },
	{ rule: 'R3f', bad: 'export const a = v as any;', good: 'export const a = v as never;' },
	{
		rule: 'R6a',
		bad: 'export const r = JSON.parse(b) as Row;',
		good: 'export const r = decodeRow(b);'
	},
	{
		rule: 'R6b',
		bad: 'export const r = JSON.parse(b);',
		// The second form is the regression: a parse into an explicitly `unknown` binding is the
		// first line of a decoder, and the compiler will not let the value be read until narrowed.
		good: 'export const r = schema.parse(JSON.parse(b));\nexport function read(b) { const v: unknown = JSON.parse(b); return v; }'
	},
	{
		rule: 'R5d',
		bad: "export const g = (v: object) => 'a' in v && 'b' in v;",
		good: "export const g = (v: object) => 'a' in v;"
	},
	{
		rule: 'CLONE',
		bad: 'export const c = JSON.parse(JSON.stringify(row));',
		good: 'export const c = structuredClone(row);'
	},
	{
		rule: 'SCHEMA1',
		bad: "import { z } from 'zod';\nexport const S = z.string();",
		good: "import { Schema } from 'effect';\nexport const S = Schema.String;"
	},

	// --- Effect ownership -------------------------------------------------------------------
	{
		rule: 'EFF1',
		bad: `${PRELUDE}export const f = () => { try { go(); } catch (e) { report(e); } };`,
		good: `${PRELUDE}export const f = () => Effect.try(go);`
	},
	{
		rule: 'EFF2',
		bad: `${PRELUDE}export const f = () => Promise.all([a, b]);`,
		good: `${PRELUDE}export const f = () => Effect.all([a, b]);`
	},
	{
		rule: 'EFF3',
		bad: `${PRELUDE}export async function f() { return 1; }`,
		good: `${PRELUDE}export const f = Effect.succeed(1);`
	},
	{
		rule: 'EFF5',
		bad: `${PRELUDE}export const f = Effect.gen(function* () { const t = Date.now(); return yield* Effect.succeed(t); });`,
		// The second workflow is the regression: `new Date(millis)` converts a Clock reading the
		// line above it, which is the shape this rule is supposed to be asking for.
		good:
			`${PRELUDE}export const f = Effect.gen(function* () { return yield* Clock.currentTimeMillis; });\n` +
			`export const g = Effect.gen(function* () { const m = yield* Clock.currentTimeMillis; return new Date(m); });`
	},
	{
		rule: 'EFF6',
		bad: `${PRELUDE}export const f = Effect.gen(function* () { throw new Error('x'); });`,
		good: `${PRELUDE}export const f = Effect.gen(function* () { return yield* Effect.fail('x'); });`
	},
	{
		rule: 'EFF7',
		bad: `${PRELUDE}export const f = Effect.gen(function* () { return yield* Effect.succeed(1); });`,
		good: `${PRELUDE}export const f = Effect.succeed(1);`
	},
	{
		rule: 'NONDET1',
		bad: `${PRELUDE}export const id = Math.random();`,
		good: `${PRELUDE}export const id = Effect.succeed(0);`
	},
	{
		rule: 'EQ1',
		bad: 'export const s = JSON.stringify(a) === JSON.stringify(b);',
		good: 'export const s = Equal.equals(a, b);'
	},
	{
		rule: 'LOG1',
		bad: "export const f = () => console.log('x');",
		good: "export const f = () => Effect.log('x');"
	},
	{
		rule: 'IO1',
		bad: "import { readFileSync } from 'node:fs';\nexport const f = () => readFileSync('/x', 'utf8');",
		good: "export const f = () => fs.readFile('/x');"
	},
	{
		rule: 'STATE1',
		bad: 'export let shared: number[] = [];',
		good: 'export const shared: ReadonlyArray<number> = [];'
	},

	// --- structure --------------------------------------------------------------------------
	{
		rule: 'A1',
		bad: 'export const f = () => { setInterval(tick, 10); };',
		good: 'export const f = () => { const t = setInterval(tick, 10); return () => clearInterval(t); };'
	},
	{
		rule: 'A5',
		bad: 'export const f = () => { try { go(); } catch (e) { throw e; } };',
		good: 'export const f = () => { try { go(); } catch (e) { throw wrap(e); } };'
	},
	{
		rule: 'A6',
		bad: 'export async function f(xs: number[]) { for (const x of xs) { await go(x); } }',
		good: 'export async function f(xs: number[]) { await Promise.all(xs.map(go)); }'
	},
	{ rule: 'D2', bad: 'export const v = flag ? 42 : 42;', good: 'export const v = flag ? 42 : 0;' },
	{
		rule: 'MOD1',
		file: 'src/workbench.ts',
		bad: "export const Workbench = import('./workbench.js');",
		good: "export * as Workbench from './workbench-contract.js';"
	},
	{
		rule: 'POLICY1',
		file: 'src/capacity.ts',
		bad: 'export const admit = (tenantId: string, work: () => void) => { void tenantId; return work(); };',
		good: 'export const admit = (tenantId: string, work: () => void) => schedule(tenantId, work);'
	},
	{
		rule: 'OPS1',
		file: 'src/health.ts',
		bad: "export const route = { status: 'ready', service: 'colony' };",
		good: "export const route = { status: snapshot.ready ? 'ready' : 'starting' };"
	},
	{
		rule: 'NODE1',
		file: 'scripts/config.ts',
		bad: 'export class Config { parseEnvironment(text: string) { const out = {}; for (const line of text.split(/\\r?\\n/)) { const match = line.match(/^([^=]+)=(.*)$/); out[match[1]] = match[2]; } return out; } }',
		good: "export { parseEnv } from 'node:util';"
	},
	{
		rule: 'NODE2',
		bad: 'async function scan(directory: string) { const entries = await readdir(directory); return descend(entries); } function descend(entries) { for (const entry of entries) if (entry.isDirectory()) scan(entry.name); }',
		good: 'export const files = readdir(root, { withFileTypes: true, recursive: true });'
	},
	{
		rule: 'NODE3',
		file: 'scripts/cli.mjs',
		bad: "import { parseArgs } from 'node:util'; const parsed = parseArgs({ options: { root: { type: 'string' } } }); const verbose = process.argv.includes('-v');",
		good: "import { parseArgs } from 'node:util'; const { values } = parseArgs({ options: { root: { type: 'string' }, json: { type: 'boolean' } } });"
	},
	{
		rule: 'NODE4',
		bad: "import { glob } from 'node:fs/promises'; export const run = (entry, input) => input.tool === 'sandbox_glob' ? entry.name.indexOf(input.pattern) >= 0 : glob(input.pattern);",
		good: "import { glob } from 'node:fs/promises'; export const run = (pattern) => glob(pattern);"
	},
	{
		rule: 'BOOT1',
		file: 'scripts/server.mjs',
		bad: "const hydrate = () => loadEnvFile('.env'); const environment = process.env; hydrate();",
		good: "loadEnvFile('.env'); const port = process.env.PORT;"
	},
	{ rule: 'P9', bad: "export * from './other.js';", good: "export { thing } from './other.js';" },
	{
		rule: 'COMPLEX1',
		bad: 'export function f(a, b, c, d) { if (a) { if (b) { if (c) { if (d) { return 1; } } } } return 0; }',
		good: 'export function f(a) { if (!a) return 0; return 1; }'
	},
	{
		rule: 'S1',
		bad: 'export const f = () => { try { go(); } catch {} };',
		good: 'export const f = () => { try { go(); } catch { /* the probe is best effort */ } };'
	},
	{
		rule: 'S3',
		bad: 'export const f = (v) => v !== null && v !== undefined;',
		good: 'export const f = (v) => v != null;'
	},
	{
		rule: 'S5',
		bad: 'export const u = Array.from(new Set(items));',
		good: 'export const u = [...new Set(items)];'
	},
	{
		rule: 'PERF3',
		bad: 'export const f = (xs) => xs.map(a).filter(b).map(c);',
		good: 'export const f = (xs) => xs.flatMap(ab);'
	},
	{
		rule: 'PERF4',
		bad: 'export const f = (xs) => xs.filter(p)[0];',
		good: 'export const f = (xs) => xs.find(p);'
	},
	{
		rule: 'E1',
		bad: "export const prod = process.env.NODE_ENV === 'production' ? 1 : 2;",
		good: 'export const prod = config.isProduction ? 1 : 2;'
	},
	{
		rule: 'E2',
		bad: 'export const ENABLE_BETA = true;',
		good: 'export const enableBeta = config.beta;'
	},
	{
		rule: 'IMP1',
		// The rule claims a *declared alias* is being bypassed, so the fixture has to declare one.
		// Without this the case passed against a rule that only ever matched `../../`.
		fixture: { 'tsconfig.json': '{"compilerOptions":{"paths":{"#lib/*":["./src/lib/*"]}}}' },
		file: 'src/lib/deep/probe.ts',
		bad: "import { v } from '../../lib/value.js';\nexport const x = v;",
		good: "import { v } from '#lib/value.js';\nexport const x = v;"
	},
	{
		rule: 'AL8',
		bad: 'export const f = (m: { role: string; content: string }) => m;',
		good: 'export const f = (m: Message) => m;'
	},
	{
		rule: 'AL9',
		bad: 'export const f = (o: { a: string; b: string; c: string; d: string }) => o;',
		good: 'export const f = (o: Options) => o;'
	},
	{
		rule: 'PERF2',
		bad: 'export const f = (xs) => xs.map((x) => Schema.decodeUnknownSync(Row)(x));',
		// The second line is the regression: `Effect.flatMap` is one continuation, not a loop, so a
		// decoder built inside it is built once.
		good:
			'export const d = Schema.decodeUnknownSync(Row);\nexport const f = (xs) => xs.map(d);\n' +
			'export const g = (e) => Effect.flatMap(e, (x) => Schema.decodeUnknownEffect(Row)(x));'
	},
	{
		rule: 'V6',
		bad: 'export const f = () => { void (async () => { await go(); })(); };',
		good: 'export const f = () => { void go(); };'
	},
	{
		rule: 'AL1',
		bad: 'type Other = { a: string };\nexport type Bare = Other;',
		good: 'export type Bare = { a: string };'
	},
	{
		rule: 'AL2',
		bad: 'export type Count = number;',
		good: 'export type Count = { readonly value: number };'
	},
	{
		rule: 'AL3',
		bad: 'export type Bag = Record<string, unknown>;',
		good: 'export type Bag = { readonly id: string };'
	},

	// --- platform ---------------------------------------------------------------------------
	{
		rule: 'ORM1',
		bad: "export const t = { id: text('thing_id') };",
		good: 'export const t = { id: text() };'
	},
	{
		rule: 'DDL1',
		bad: "export const t = pgTable('things', {});",
		good: 'export const t = defineModel({});'
	},
	{
		rule: 'SQL1',
		bad:
			"export const q = 'SELECT id FROM users';\n" +
			'export const fragment = sql`now()`;\n' +
			"export const seed = 'insert into h (s) values (true) on conflict do nothing';\n" +
			"export const stub = (i) => i.sql === 'select name from bolt_secrets';",
		// Transaction control and narrowly identifiable schema bootstrap DDL are the only raw SQL
		// forms the production scanner accepts.
		good:
			'export const q = db.users.findMany({});\n' +
			'export const boot = `create table if not exists ${t} (id uuid)`;\n' +
			'export const hist = `create table ${t}_history (id uuid)`;\n' +
			'export const trig = `create trigger t after insert on x execute function f()`;\n' +
			"export const policy = 'create policy tenant_rows on things using (tenant_id = current_user)';\n" +
			'export const predicate = { $sql: \'"tenant_id" = current_user\' } as const;\n' +
			"export const begin = 'begin';\n" +
			"export const commit = 'commit';\n" +
			"export const rollback = 'rollback';"
	},
	{
		rule: 'SQL1',
		file: 'src/collections/things/+model.ts',
		bad: "export const runtimeRead = 'select id from things';",
		good: "export const key = text().generatedAlwaysAs(sql`source ->> 'kind'`);"
	},
	{
		rule: 'SQL1',
		bad: "export function request() { const statement = { sql: 'insert into things (id) values ($1)' }; return { _tag: 'Query', ...statement }; }",
		good: "export function request() { const statement = { sql: 'insert into things (id) values ($1)', parameters: [id] }; return { _tag: 'Transaction', statements: [statement] }; }"
	},
	{
		rule: 'SQL1',
		bad: "import { transactionSql } from './lookalike.js';\nexport const statement = transactionSql('insert into things (id) values ($1)', [id]);",
		good: "import { transactionSql } from '#lib/runtime/persistence.js';\nexport const statement = transactionSql('insert into things (id) values ($1)', [id]);"
	},
	{
		rule: 'QRY2',
		bad: 'export const f = () => { void query.refresh(); };',
		good:
			'export const f = () => { const rows = client.db.things.findMany({}); return rows; };\n' +
			'export const updateToc = () => toc.refresh();'
	},
	{
		rule: 'QRY4',
		bad: 'export interface RemoteQuery<T> { readonly current: T; readonly refresh: () => Promise<void>; }',
		good:
			'export interface RemoteQuery<T> { readonly current: T; }\n' +
			'export interface DocumentToc { readonly refresh: () => void; }'
	},
	{
		rule: 'LIVE1',
		bad: 'export const pollStatus = () => status();',
		good:
			'export const rows = client.db.things.findMany({});\n' +
			'export const clock = setInterval(() => { currentTime = new Date(); }, 60_000);'
	},
	{
		rule: 'LIVE1',
		bad: 'export async function watch() { while (true) { await sleep(1000); await status(); } }',
		good: 'export function transform(rows) { for (const row of rows) emit(row); }'
	},
	{
		rule: 'LIVE2',
		bad:
			"export const source = new EventSource('/events');\n" +
			"export const contentType = 'text/event-stream';\n" +
			"export const protocol = 'sse';",
		good: "export const transport = 'websocket';"
	},
	{
		rule: 'QRY3',
		bad: 'export const rows = client.db.things.findMany({});',
		good: 'export const rows = $derived(client.db.things.findMany({}));'
	},
	{
		rule: 'UI18',
		// The rule is scoped to client UI, which is what its summary always claimed; the same call in
		// the transport layer below the generated client is that layer doing its job.
		file: 'src/ui/probe.ts',
		bad: 'export const f = () => transport.command({});',
		good: 'export const f = () => client.db.things.create({});'
	},
	{
		rule: 'LEGACY1',
		bad: '/** @deprecated use next */\nexport function old() { return 1; }',
		// The second declaration is the regression: prose naming the tag is not a deprecation, and
		// trivia reaching back to the previous token is not this declaration's comment.
		good: '/** Current. */\nexport function current() { return 1; }\n/** Reads the `@deprecated` tag. */\nexport function reader() { return 2; }'
	},
	{
		rule: 'COMPAT1',
		bad: '// legacy forwarder for the old name\nexport const oldName = newName;',
		good: 'export const name = newName;'
	},
	{
		rule: 'TRANS1',
		bad: '// TODO: remove once the migration lands\nexport const bridge = 1;',
		good: '// Kept because the importer needs it.\nexport const bridge = 1;'
	},
	{
		rule: 'TRANS2',
		bad: 'export const n = row.name ?? row.legacy_name;',
		good: 'export const n = row.name;'
	},
	{
		rule: 'E3',
		bad: "export const url = process.env['SECRET_URL'] ?? '';",
		good: 'export const url = config.secretUrl;'
	}
];

function scan(
	source: string,
	file: string,
	rules: ReadonlyArray<Rule>,
	fixture?: Readonly<Record<string, string>>
): ReadonlyArray<string> {
	const root = mkdtempSync(join(tmpdir(), 'doctor-port-'));
	try {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), source);
		writeFileSync(join(root, 'package.json'), '{"name":"port","type":"module"}');
		for (const [name, contents] of Object.entries(fixture ?? {})) {
			mkdirSync(dirname(join(root, name)), { recursive: true });
			writeFileSync(join(root, name), contents);
		}
		execFileSync('git', ['init', '-q'], { cwd: root });
		execFileSync('git', ['add', '-A'], { cwd: root });
		return runRules({ root, rules, files: [file] }).map((finding) => finding.rule);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('every ported rule reports its positive example', () => {
	const missing: Array<string> = [];
	for (const testCase of CASES) {
		const file = testCase.file ?? 'src/probe.ts';
		const rule = ALL.find((candidate) => candidate.id === testCase.rule);
		assert.ok(rule !== undefined, `${testCase.rule} is not in any pack`);
		if (!scan(testCase.bad, file, [rule], testCase.fixture).includes(testCase.rule))
			missing.push(
				`${testCase.rule}: no finding for ${testCase.bad.replace(/\n/g, ' ').slice(0, 60)}`
			);
	}
	assert.deepEqual(missing, [], missing.join('\n'));
});

test('no ported rule reports its negative example', () => {
	const spurious: Array<string> = [];
	for (const testCase of CASES) {
		const file = testCase.file ?? 'src/probe.ts';
		const rule = ALL.find((candidate) => candidate.id === testCase.rule)!;
		if (scan(testCase.good, file, [rule], testCase.fixture).includes(testCase.rule))
			spurious.push(`${testCase.rule}: reported ${testCase.good.replace(/\n/g, ' ').slice(0, 60)}`);
	}
	assert.deepEqual(spurious, [], spurious.join('\n'));
});

test('simplification rules keep their declared service and bootstrap boundaries', () => {
	const rule = (id: string): Rule => ALL.find((candidate) => candidate.id === id)!;
	const reports = (id: string, source: string, file: string): boolean =>
		scan(source, file, [rule(id)]).includes(id);

	for (const source of [
		"export * from '.';",
		"const self = require('./index.js');",
		"import Self = require('./index.js');",
		"export const self = import('./index.js');"
	])
		assert.equal(reports('MOD1', source, 'src/index.ts'), true, source);
	assert.equal(
		reports('MOD1', "<script>import Tree from './Tree.svelte';</script>", 'src/Tree.svelte'),
		false
	);
	assert.equal(
		reports('MOD1', "<script>import * as Tree from './Tree.svelte';</script>", 'src/Tree.svelte'),
		true
	);

	for (const source of [
		'export const admit = (tenantId: string) => 1;',
		'export const admit = (_tenantId: string) => void _tenantId;',
		"export const admit = (tenantId: string) => console.log('tenant', tenantId);",
		"export const admit = (tenantId: string) => { const key = tenantId; return console.log('tenant', JSON.stringify(key)); };",
		'export const admit = (tenantId: string) => tenantId;',
		'export const admit = (tenantId: string, enabled: boolean) => enabled ? tenantId : "none";',
		'export const admit = (tenantId: string) => tenantId.length;'
	])
		assert.equal(reports('POLICY1', source, 'src/capacity.ts'), true, source);
	assert.equal(
		reports(
			'POLICY1',
			'export const admit = (tenantId: string) => capacityByTenant.get(tenantId);',
			'src/capacity.ts'
		),
		false
	);
	assert.equal(
		reports(
			'POLICY1',
			'export const admit = (tenantId: string) => { const key = tenantId; return capacityByTenant.get(key); };',
			'src/capacity.ts'
		),
		false
	);
	assert.equal(
		reports(
			'POLICY1',
			'export interface Policy { admit(tenantId: string): void }',
			'src/policy.ts'
		),
		false
	);

	for (const source of [
		"export const route = { health: 'ready' };",
		"export const route = { status: 'ready', service: 'colony' };",
		'export const state = { accepting: true, outstanding: 0 };'
	])
		assert.equal(reports('OPS1', source, 'src/health.ts'), true, source);
	assert.equal(reports('OPS1', "export const row = { health: 'ready' };", 'src/domain.ts'), false);
	assert.equal(
		reports('OPS1', "export const row = { status: 'ready' };", 'src/health.test.ts'),
		false
	);
	assert.equal(
		reports(
			'OPS1',
			"export const route = { status: dependencies.ready ? 'ready' : 'starting' };",
			'src/health.ts'
		),
		false
	);

	assert.equal(
		reports('NODE1', 'export const parseEnv = (value: string) => value;', 'scripts/dev.mjs'),
		false
	);
	for (const source of [
		"export const environment = (text) => { const out = {}; for (const line of text.split('\\n')) { const at = line.indexOf('='); out[line.slice(0, at)] = line.slice(at + 1); } return out; };",
		'export class Config { parseEnv(text) { const out = {}; for (const line of text.split(/\\r?\\n/)) { const pair = /^([^=]+)=(.*)$/.exec(line); out[pair[1]] = pair[2]; } return out; } }',
		"export const parser = { environment(text) { return Object.fromEntries(text.split('\\n').map((line) => line.split('='))); } };"
	])
		assert.equal(reports('NODE1', source, 'scripts/dev.mjs'), true, source);

	for (const source of [
		'async function visit(root) { /* ignore this prose */ const entries = await readdir(root); entries.forEach((entry) => { if (entry.isDirectory()) visit(entry.name); }); }',
		'function scan(root) { const entries = readdirSync(root); descend(entries); } function descend(entries) { for (const entry of entries) scan(entry.name); }',
		'function visit(root) { const entries = readdirSync(root); if (ignoredFile(root)) log(root); for (const entry of entries) visit(entry.name); }'
	])
		assert.equal(reports('NODE2', source, 'src/files.ts'), true, source);
	assert.equal(
		reports(
			'NODE2',
			'function visit(root) { const entries = readdirSync(root); for (const entry of entries) { if (ignoredFile(entry)) continue; visit(entry.name); } }',
			'src/files.ts'
		),
		false
	);
	assert.equal(
		reports(
			'NODE2',
			'function visit(root) { const entries = readdirSync(root); for (const entry of entries) { if (ignoredFile(entry)) log(entry); else visit(entry.name); } }',
			'src/files.ts'
		),
		false
	);

	assert.equal(
		reports(
			'NODE3',
			"import { parseArgs } from 'node:util'; parseArgs({ options: { root: { type: 'string' } }, args: process.argv.slice(2) });",
			'scripts/cli.mjs'
		),
		false
	);
	for (const source of [
		"const verbose = process.argv.includes('-v');",
		"import { parseArgs } from 'node:util'; parseArgs({ options: {} }); const root = process.argv.find((value) => value.startsWith('--root='));",
		"const args = process.argv.slice(2); switch (args[0]) { case '-v': enableVerbose(); }"
	])
		assert.equal(reports('NODE3', source, 'scripts/cli.mjs'), true, source);

	assert.equal(
		reports(
			'NODE4',
			"import { glob } from 'node:fs/promises'; export const sandbox_glob = (pattern) => glob(pattern);",
			'src/files.ts'
		),
		false
	);
	assert.equal(
		reports(
			'NODE4',
			"import { glob } from 'node:fs/promises'; export const run = (name, patterns) => patterns.includes(name) ? glob('**/*') : [];",
			'src/files.ts'
		),
		false
	);
	assert.equal(
		reports(
			'NODE4',
			"import { glob } from 'node:fs/promises'; export const sandbox_glob = (name, pattern) => name.includes(pattern) ? [name] : glob(pattern);",
			'src/files.ts'
		),
		true
	);
	assert.equal(
		reports(
			'NODE4',
			'export const sandbox_glob = (name, pattern) => pattern.includes(name);',
			'src/files.ts'
		),
		true
	);

	for (const source of [
		"const environment = process.env; loadEnvFile('.env');",
		"function hydrate() { loadEnvFile('.env'); } const port = process.env.PORT; hydrate();",
		"const port = (() => process.env.PORT)(); loadEnvFile('.env');"
	])
		assert.equal(reports('BOOT1', source, 'scripts/server.mjs'), true, source);
	assert.equal(
		reports(
			'BOOT1',
			"function hydrate() { loadEnvFile('.env'); } hydrate(); const environment = process.env;",
			'scripts/server.mjs'
		),
		false
	);
});

test('every rule in every pack has a case in this table', () => {
	const covered = new Set(CASES.map((testCase) => testCase.rule));
	// Layout and rune rules are covered by the svelte suite, which needs component fixtures.
	const componentOnly = new Set(svelteRules.map((rule) => rule.id));
	const uncovered = ALL.map((rule) => rule.id).filter(
		(id) => !covered.has(id) && !componentOnly.has(id)
	);
	assert.deepEqual(uncovered, [], `no port case for: ${uncovered.join(' ')}`);
});
