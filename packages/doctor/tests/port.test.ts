/**
 * Port acceptance for the neutral packs: typed boundaries and structure. Every rule reports
 * source that must be reported and none reports source that must not — the table is the
 * criterion, and a rule without both halves is not ported. Effect ownership lives in
 * packages/doctor-effect; the Norbital product rules live in packages/doctor-norbital.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { boundaryRules, runRules, structureRules, type Rule } from '../build/index.js';

const ALL: ReadonlyArray<Rule> = [...boundaryRules, ...structureRules];

type Case = Readonly<{
	rule: string;
	bad: string;
	good: string;
	file?: string;
	fixture?: Readonly<Record<string, string>>;
}>;
const CASES: ReadonlyArray<Case> = [
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
		good: "export const g = (v: object, x: unknown) => 'a' in v || x === undefined;"
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
	{
		rule: 'Q1',
		bad: 'export const onReady = (callback) => callback();',
		good: 'export const onReady = (callback) => { log(); callback(); };'
	},
	{
		rule: 'Q3',
		bad: 'const shim = (input) => bridge(input);\nexport const kickoff = (input) => shim(input);',
		good: 'export const kickoff = (input) => bridge(input);'
	},
	{
		rule: 'Q4',
		bad: 'const label = (name) => name.trim();\nexport const show = (name) => label(name);',
		good: 'export const show = (name) => name.trim();'
	},
	{
		rule: 'Q5',
		bad: 'export const f = (owner: undefined) => owner;',
		good: 'export const f = (owner?: string) => owner;'
	},
	{
		rule: 'RET1',
		bad: 'export function labeled(name: string): string { return name.trim(); }',
		good: 'export function labeled(name: string) { return name.trim(); }'
	},
	{
		rule: 'GUARD1',
		bad: "export const record = (v) => typeof v === 'object' && v !== null ? v : undefined;",
		good: 'export const record = (v) => Schema.decodeUnknownOption(JsonObject)(v);'
	},
	{
		rule: 'GUARD2',
		bad: "export const pick = (style) => typeof style === 'string' ? style : style.context;",
		good: "export const pick = (style) => (Schema.is(Schema.String)(style) ? style : style.context);"
	},
	{
		rule: 'REFLECT1',
		bad: "export const name = Reflect.get(Object(manifest), 'name');",
		good: "export const name = decoded.name;"
	},
	{
		rule: 'STATE2',
		bad: 'const cache = new Map();\nexport const get = (k) => { cache.set(k, 1); return cache.get(k); };',
		good: 'const index = new Map([["a", 1]]);\nexport const get = (k) => index.get(k);'
	},
	{
		rule: 'STD2',
		bad: 'export const message = (cause) => cause instanceof Error ? cause.message : String(cause);',
		good: 'export const message = (cause) => getErrorMessage(cause);'
	},
	{
		rule: 'STD3',
		bad: 'export const normalize = (cause) => cause instanceof Error ? cause : new Error(String(cause));',
		good: 'export const normalize = (cause) => toError(cause);'
	},
	{
		rule: 'PARSE1',
		bad: "export const relationValue = (value) => typeof value === 'string' ? JSON.parse(value) as unknown : value;",
		good: 'export const relationValue = (value) => Schema.decodeUnknownSync(Schema.parseJson(Schema.Unknown))(value);'
	},
	{
		rule: 'VOID1',
		bad: 'export const f = (p) => { void Promise.resolve(p).catch(report); };',
		good: 'export const f = (p) => { return Promise.resolve(p).catch(report); };'
	},
	{
		rule: 'EFF8',
		bad: 'export const run = (context, input) => Effect.gen(function* () { return json(yield* (yield* Sync.Service).advance(context.effectId, input)); });',
		good: 'export const run = (context, input) => Effect.map(workspaceManifest(context, false), json);'
	},
	{
		rule: 'EFF9',
		bad: 'export const read = () => Effect.promise(() => file.text());',
		good: 'export const read = () => Effect.tryPromise({ try: () => file.text(), catch: toError });'
	},
	{
		rule: 'EFF10',
		bad: "export const GET = () => Effect.gen(function* () { return error(400, 'bad'); });",
		good: "export const GET = () => Effect.fail('bad');"
	},
	{
		rule: 'SANDWICH1',
		bad: 'export const tick = () => Effect.tryPromise(() => runtime.runPromise(once()));',
		good: 'export const tick = () => once();'
	},
	{
		rule: 'IDENT1',
		bad: 'export const f = (r) => r.pipe(Effect.match({ onFailure: () => null, onSuccess: (value) => value }));',
		good: 'export const f = (r) => r.pipe(Effect.orElseSucceed(() => null));'
	},
	{
		rule: 'SWALLOW1',
		bad: 'export const f = (e) => e.pipe(Effect.catch(() => {}));',
		good: 'export const f = (e) => e.pipe(Effect.catch((error) => Effect.log(error)));'
	},
	{
		rule: 'FETCH1',
		bad: "export const load = () => fetch('/api/items');",
		good: "export const load = () => httpRequest(url, { operation: 'load' });"
	},
	{
		rule: 'EFF11',
		bad: 'export const run = (): Effect.Effect<void, unknown> => Effect.void;',
		good: 'export const provide = <A, E>(e: Effect.Effect<A, E, unknown>): Effect.Effect<A, E> => e;'
	},
	{
		rule: 'COERCE1',
		bad: 'export const qty = (input) => Number(input.quantity);',
		good: 'export const qty = (input) => decodeNumber(input.quantity);'
	},
	{
		rule: 'SWALLOW2',
		bad: 'export const read = (path) => readFileEffect(path).pipe(Effect.catch(() => Effect.succeed([])));',
		good: 'export const read = (path) => readFileEffect(path).pipe(Effect.catch((cause) => Effect.fail(cause)));'
	},
	{
		rule: 'ERR1',
		bad: 'export const fail = (cause) => new Error(String(cause));',
		good: "export const fail = (cause) => new Error('request failed', { cause });"
	},
	{
		rule: 'ERR2',
		bad: "export const fail = (effect) => effect.pipe(Effect.catch((cause) => new Error('request failed')));",
		good: "export const fail = (effect) => effect.pipe(Effect.catch((cause) => new Error('request failed', { cause })));"
	},
	{
		rule: 'STATE3',
		bad: 'let registered;\nfunction register(shape) { registered = shape; return registered; }',
		good: 'export function create(shape) { let registered; registered = shape; return registered; }'
	}

	// --- platform ---------------------------------------------------------------------------
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
	assert.equal(
		reports(
			'MOD1',
			"import type { TaskSelectorModel } from './conversation-selector.js';",
			'src/conversation-selector.svelte'
		),
		false
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

	assert.equal(
		reports(
			'Q3',
			'const purge = (owner, options) => real(owner, options);\nexport const fence = (options) => purge(undefined, options);',
			'src/reset.ts'
		),
		true
	);
	assert.equal(
		reports(
			'Q3',
			'export const purge = (owner, options) => real(owner, options);\nexport const fence = (options) => purge(undefined, options);',
			'src/reset.ts'
		),
		false
	);
	assert.equal(
		reports(
			'Q3',
			'const purge = (owner, options) => real(owner, options);\nexport const a = (o) => purge(undefined, o);\nexport const b = (o) => purge(undefined, o);',
			'src/reset.ts'
		),
		false
	);
	assert.equal(reports('Q5', 'export const f = (owner: string | undefined) => owner;', 'src/reset.ts'), false);
	assert.equal(reports('Q5', 'export const f = (owner: void) => owner;', 'src/reset.ts'), true);
	assert.equal(
		reports('Q5', 'export interface Handler { click(this: void): void }', 'src/view.ts'),
		false
	);
	assert.equal(
		reports('Q1', 'export const handleClick = (event) => props.onClick(event);', 'src/view.ts'),
		true
	);
	assert.equal(
		reports('Q1', 'export const start = (value) => decorate(value);', 'src/view.ts'),
		false
	);
	assert.equal(
		reports(
			'STATE2',
			'const index = new Map();\nfor (const [k, v] of pairs) index.set(k, v);\nexport const get = (k) => index.get(k);',
			'src/cache.ts'
		),
		false
	);
	assert.equal(
		reports('GUARD1', "export const ok = Schema.is(JsonObject)(value);", 'src/guard.ts'),
		false
	);
	assert.equal(
		reports(
			'GUARD1',
			"export const record = (v: unknown): Readonly<Record<string, unknown>> | undefined => typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Readonly<Record<string, unknown>>) : undefined;",
			'src/guard.ts'
		),
		true
	);
	assert.equal(
		reports(
			'GUARD1',
			"export const bag = (v) => typeof v === 'object' && v !== null ? v : {};",
			'src/guard.ts'
		),
		true
	);
	assert.equal(
		reports('REFLECT1', "export const name = Reflect.get(decoded, 'name');", 'src/io.ts'),
		false
	);
	assert.equal(
		reports('REFLECT1', "export const code = Reflect.get(Object(cause), 'code');", 'src/io.ts'),
		false
	);
	assert.equal(
		reports(
			'GUARD1',
			"export const missing = (cause) => typeof cause === 'object' && cause !== null && Reflect.get(cause, 'code') === 'ENOENT';",
			'src/guard.ts'
		),
		false
	);
	assert.equal(
		reports('R3a', 'export const bag = value as Readonly<Record<string, unknown>>;', 'src/io.ts'),
		true
	);
	assert.equal(
		reports('R3b', 'export const handle = data as never as ReferenceHandle;', 'src/io.ts'),
		true
	);
	assert.equal(
		reports('STD2', 'export const message = (cause) => getErrorMessage(cause);', 'src/io.ts'),
		false
	);
});
const componentOnly = new Set<string>();

test('every rule in every pack has a case in this table', () => {
	const covered = new Set(CASES.map((testCase) => testCase.rule));
	const uncovered = ALL.map((rule) => rule.id).filter(
		(id) => !covered.has(id) && !componentOnly.has(id)
	);
	assert.deepEqual(uncovered, [], `no port case for: ${uncovered.join(' ')}`);
});
