/**
 * D8 corpus parity for the structure visitors of the original 53.
 *
 * A rule is proven only when at least three discriminating observations pass
 * (a bad source reports, a good source does not). Realm 0-vs-0 is not an
 * observation — that is how a first harness rubber-stamped 31 archived drafts.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { runRules, structureRules, type Rule } from '../build/index.js';

/** The 27 structure members of the original 53 imperative visitors. */
const STRUCTURE_53 = [
	'A1',
	'A5',
	'A6',
	'AL1',
	'AL2',
	'AL3',
	'AL8',
	'AL9',
	'BOOT1',
	'COMPLEX1',
	'D2',
	'E1',
	'IMP1',
	'MOD1',
	'NODE1',
	'NODE2',
	'NODE3',
	'NODE4',
	'OPS1',
	'P9',
	'PERF2',
	'PERF3',
	'POLICY1',
	'Q3',
	'Q4',
	'S1',
	'V6'
] as const;

/** Leftover after the first sweep — these are the ids this pass can move. */
const LEFTOVER = ['COMPLEX1', 'NODE2', 'OPS1', 'PERF2', 'POLICY1', 'Q3', 'Q4'] as const;

const FLOOR = 3;
const PACKS = join(dirname(fileURLToPath(import.meta.url)), '../packs/structure');

type Expectation = 'fire' | 'quiet';

type Observation = Readonly<{
	id: string;
	source: string;
	expect: Expectation;
	file?: string;
	fixture?: Readonly<Record<string, string>>;
}>;

type Documented = Readonly<{
	id: string;
	bad: ReadonlyArray<string>;
	good: ReadonlyArray<string>;
	file: string | undefined;
	fixture: Readonly<Record<string, string>>;
}>;

function documented(): ReadonlyMap<string, Documented> {
	const rows = new Map<string, Documented>();
	for (const name of readdirSync(PACKS).filter((entry) => /\.ya?ml$/.test(entry))) {
		const document = parseYaml(readFileSync(join(PACKS, name), 'utf8')) as {
			id?: string;
			examples?: {
				bad?: ReadonlyArray<string>;
				good?: ReadonlyArray<string>;
				fixture?: Readonly<Record<string, string>>;
				file?: string;
			};
		};
		if (document.id === undefined) continue;
		rows.set(document.id, {
			id: document.id,
			bad: document.examples?.bad ?? [],
			good: document.examples?.good ?? [],
			file: document.examples?.file,
			fixture: document.examples?.fixture ?? {}
		});
	}
	return rows;
}

/** Extra cases already asserted in `port.test.ts` — visitor-era, not invented here. */
const EXTRAS: ReadonlyArray<Observation> = [
	{
		id: 'POLICY1',
		file: 'src/capacity.ts',
		source: 'export const admit = (tenantId: string) => 1;',
		expect: 'fire'
	},
	{
		id: 'POLICY1',
		file: 'src/capacity.ts',
		source: 'export const admit = (_tenantId: string) => void _tenantId;',
		expect: 'fire'
	},
	{
		id: 'POLICY1',
		file: 'src/capacity.ts',
		source: "export const admit = (tenantId: string) => console.log('tenant', tenantId);",
		expect: 'fire'
	},
	{
		id: 'POLICY1',
		file: 'src/capacity.ts',
		source:
			"export const admit = (tenantId: string) => { const key = tenantId; return console.log('tenant', JSON.stringify(key)); };",
		expect: 'fire'
	},
	{
		id: 'POLICY1',
		file: 'src/capacity.ts',
		source: 'export const admit = (tenantId: string) => tenantId;',
		expect: 'fire'
	},
	{
		id: 'POLICY1',
		file: 'src/capacity.ts',
		source: 'export const admit = (tenantId: string, enabled: boolean) => enabled ? tenantId : "none";',
		expect: 'fire'
	},
	{
		id: 'POLICY1',
		file: 'src/capacity.ts',
		source: 'export const admit = (tenantId: string) => tenantId.length;',
		expect: 'fire'
	},
	{
		id: 'POLICY1',
		file: 'src/capacity.ts',
		source: 'export const admit = (tenantId: string) => capacityByTenant.get(tenantId);',
		expect: 'quiet'
	},
	{
		id: 'POLICY1',
		file: 'src/capacity.ts',
		source:
			'export const admit = (tenantId: string) => { const key = tenantId; return capacityByTenant.get(key); };',
		expect: 'quiet'
	},
	{
		id: 'POLICY1',
		file: 'src/policy.ts',
		source: 'export interface Policy { admit(tenantId: string): void }',
		expect: 'quiet'
	},
	{
		id: 'OPS1',
		file: 'src/health.ts',
		source: "export const route = { health: 'ready' };",
		expect: 'fire'
	},
	{
		id: 'OPS1',
		file: 'src/health.ts',
		source: "export const route = { status: 'ready', service: 'colony' };",
		expect: 'fire'
	},
	{
		id: 'OPS1',
		file: 'src/health.ts',
		source: 'export const state = { accepting: true, outstanding: 0 };',
		expect: 'fire'
	},
	{
		id: 'OPS1',
		file: 'src/domain.ts',
		source: "export const row = { health: 'ready' };",
		expect: 'quiet'
	},
	{
		id: 'OPS1',
		file: 'src/health.test.ts',
		source: "export const row = { status: 'ready' };",
		expect: 'quiet'
	},
	{
		id: 'OPS1',
		file: 'src/health.ts',
		source:
			"export const route = { status: dependencies.ready ? 'ready' : 'starting' };",
		expect: 'quiet'
	},
	{
		id: 'NODE2',
		file: 'src/files.ts',
		source:
			'async function visit(root) { /* ignore this prose */ const entries = await readdir(root); entries.forEach((entry) => { if (entry.isDirectory()) visit(entry.name); }); }',
		expect: 'fire'
	},
	{
		id: 'NODE2',
		file: 'src/files.ts',
		source:
			'function scan(root) { const entries = readdirSync(root); descend(entries); } function descend(entries) { for (const entry of entries) scan(entry.name); }',
		expect: 'fire'
	},
	{
		id: 'NODE2',
		file: 'src/files.ts',
		source:
			'function visit(root) { const entries = readdirSync(root); if (ignoredFile(root)) log(root); for (const entry of entries) visit(entry.name); }',
		expect: 'fire'
	},
	{
		id: 'NODE2',
		file: 'src/files.ts',
		source:
			'function visit(root) { const entries = readdirSync(root); for (const entry of entries) { if (ignoredFile(entry)) continue; visit(entry.name); } }',
		expect: 'quiet'
	},
	{
		id: 'NODE2',
		file: 'src/files.ts',
		source:
			'function visit(root) { const entries = readdirSync(root); for (const entry of entries) { if (ignoredFile(entry)) log(entry); else visit(entry.name); } }',
		expect: 'quiet'
	},
	{
		id: 'Q3',
		file: 'src/reset.ts',
		source:
			'const purge = (owner, options) => real(owner, options);\nexport const fence = (options) => purge(undefined, options);',
		expect: 'fire'
	},
	{
		id: 'Q3',
		file: 'src/reset.ts',
		source:
			'export const purge = (owner, options) => real(owner, options);\nexport const fence = (options) => purge(undefined, options);',
		expect: 'quiet'
	},
	{
		id: 'Q3',
		file: 'src/reset.ts',
		source:
			'const purge = (owner, options) => real(owner, options);\nexport const a = (o) => purge(undefined, o);\nexport const b = (o) => purge(undefined, o);',
		expect: 'quiet'
	},
	{
		id: 'MOD1',
		file: 'src/Tree.svelte',
		source: "<script>import Tree from './Tree.svelte';</script>",
		expect: 'quiet'
	},
	{
		id: 'MOD1',
		file: 'src/Tree.svelte',
		source: "<script>import * as Tree from './Tree.svelte';</script>",
		expect: 'fire'
	},
	{
		id: 'MOD1',
		file: 'src/conversation-selector.svelte',
		source: "import type { TaskSelectorModel } from './conversation-selector.js';",
		expect: 'quiet'
	},
	{
		id: 'COMPLEX1',
		file: 'src/probe.ts',
		source:
			'export function f(xs, ys, zs, ws) { for (const x of xs) { for (const y of ys) { for (const z of zs) { for (const w of ws) { return 1; } } } } return 0; }',
		expect: 'fire'
	},
	{
		id: 'COMPLEX1',
		file: 'src/probe.ts',
		source:
			'export function f(a, b, c, d) { while (a) { while (b) { while (c) { while (d) { return 1; } } } } return 0; }',
		expect: 'fire'
	},
	{
		id: 'COMPLEX1',
		file: 'src/probe.ts',
		source:
			'export function f() { try { try { try { try { return 1; } catch { return 0; } } catch { return 0; } } catch { return 0; } } catch { return 0; } }',
		expect: 'fire'
	},
	{
		id: 'COMPLEX1',
		file: 'src/probe.ts',
		source:
			'export const f = (a, b, c, d) => { if (a) { if (b) { if (c) { if (d) { return 1; } } } } return 0; };',
		expect: 'fire'
	},
	{
		id: 'COMPLEX1',
		file: 'src/probe.ts',
		source:
			'export class C { f(a, b, c, d) { if (a) { if (b) { if (c) { if (d) { return 1; } } } } return 0; } }',
		expect: 'fire'
	},
	{
		id: 'COMPLEX1',
		file: 'src/probe.ts',
		source: 'export function f(a, b, c) { if (a) { if (b) { if (c) { return 1; } } } return 0; }',
		expect: 'quiet'
	},
	{
		id: 'COMPLEX1',
		file: 'src/probe.ts',
		source:
			'export function f(a) { switch (a) { case 1: return 1; case 2: return 2; default: return 0; } }',
		expect: 'quiet'
	},
	{
		id: 'PERF2',
		file: 'src/probe.ts',
		source: 'export const f = (xs) => xs.filter((x) => Schema.decodeUnknownSync(Row)(x));',
		expect: 'fire'
	},
	{
		id: 'PERF2',
		file: 'src/probe.ts',
		source: 'export const f = (xs) => xs.forEach((x) => Schema.decodeUnknown(Row)(x));',
		expect: 'fire'
	},
	{
		id: 'PERF2',
		file: 'src/probe.ts',
		source: 'export const f = (xs) => xs.reduce((_, x) => Schema.decodeUnknownSync(Row)(x), null);',
		expect: 'fire'
	},
	{
		id: 'PERF2',
		file: 'src/probe.ts',
		source: 'export const f = (xs) => xs.some((x) => Schema.validate(Row)(x));',
		expect: 'fire'
	},
	{
		id: 'PERF2',
		file: 'src/probe.ts',
		source: 'export const f = (xs) => Option.map(xs, (x) => Schema.decodeUnknownSync(Row)(x));',
		expect: 'quiet'
	},
	{
		id: 'PERF2',
		file: 'src/probe.ts',
		source: 'export const f = (x) => Schema.decodeUnknownSync(Row)(x);',
		expect: 'quiet'
	},
	{
		id: 'PERF2',
		file: 'src/probe.ts',
		source: 'export const f = (xs) => xs.map((x) => decode(x));',
		expect: 'quiet'
	},
	{
		id: 'Q4',
		file: 'src/probe.ts',
		source: 'const tmp = (name) => name.trim();\nexport const show = (name) => tmp(name);',
		expect: 'fire'
	},
	{
		id: 'Q4',
		file: 'src/probe.ts',
		source: 'const helper = (name) => name.toLowerCase();\nexport const show = (name) => helper(name);',
		expect: 'fire'
	},
	{
		id: 'Q4',
		file: 'src/probe.ts',
		source:
			'const isRuleList = (value: unknown): value is ReadonlyArray<string> => Array.isArray(value);\nexport const check = (value: unknown) => isRuleList(value);',
		expect: 'quiet'
	},
	{
		id: 'Q4',
		file: 'src/probe.ts',
		source:
			'const label = (name) => name.trim();\nexport const a = (n) => label(n);\nexport const b = (n) => label(n);',
		expect: 'quiet'
	},
	{
		id: 'Q4',
		file: 'src/probe.ts',
		source:
			'const bump = (row) => { row.n = 1; return row.n; };\nexport const show = (row) => bump(row);',
		expect: 'quiet'
	},
	{
		id: 'Q4',
		file: 'src/probe.ts',
		source:
			'const escapeLikePattern = (value) => value.replace(/[%_\\\\]/g, "\\\\$&");\nexport const like = (value) => escapeLikePattern(value);',
		expect: 'quiet'
	},
	{
		id: 'NODE1',
		file: 'scripts/dev.mjs',
		source: 'export const parseEnv = (value: string) => value;',
		expect: 'quiet'
	},
	{
		id: 'NODE1',
		file: 'scripts/dev.mjs',
		source:
			"export const environment = (text) => { const out = {}; for (const line of text.split('\\n')) { const at = line.indexOf('='); out[line.slice(0, at)] = line.slice(at + 1); } return out; };",
		expect: 'fire'
	},
	{
		id: 'NODE1',
		file: 'scripts/dev.mjs',
		source:
			'export class Config { parseEnv(text) { const out = {}; for (const line of text.split(/\\r?\\n/)) { const pair = /^([^=]+)=(.*)$/.exec(line); out[pair[1]] = pair[2]; } return out; } }',
		expect: 'fire'
	},
	{
		id: 'NODE1',
		file: 'scripts/dev.mjs',
		source:
			"export const parser = { environment(text) { return Object.fromEntries(text.split('\\n').map((line) => line.split('='))); } };",
		expect: 'fire'
	},
	{
		id: 'NODE3',
		file: 'scripts/cli.mjs',
		source:
			"import { parseArgs } from 'node:util'; parseArgs({ options: { root: { type: 'string' } }, args: process.argv.slice(2) });",
		expect: 'quiet'
	},
	{
		id: 'NODE3',
		file: 'scripts/cli.mjs',
		source: "const verbose = process.argv.includes('-v');",
		expect: 'fire'
	},
	{
		id: 'NODE3',
		file: 'scripts/cli.mjs',
		source:
			"import { parseArgs } from 'node:util'; parseArgs({ options: {} }); const root = process.argv.find((value) => value.startsWith('--root='));",
		expect: 'fire'
	},
	{
		id: 'NODE3',
		file: 'scripts/cli.mjs',
		source: "const args = process.argv.slice(2); switch (args[0]) { case '-v': enableVerbose(); }",
		expect: 'fire'
	},
	{
		id: 'NODE4',
		file: 'src/files.ts',
		source:
			"import { glob } from 'node:fs/promises'; export const sandbox_glob = (pattern) => glob(pattern);",
		expect: 'quiet'
	},
	{
		id: 'NODE4',
		file: 'src/files.ts',
		source:
			"import { glob } from 'node:fs/promises'; export const run = (name, patterns) => patterns.includes(name) ? glob('**/*') : [];",
		expect: 'quiet'
	},
	{
		id: 'NODE4',
		file: 'src/files.ts',
		source:
			"import { glob } from 'node:fs/promises'; export const sandbox_glob = (name, pattern) => name.includes(pattern) ? [name] : glob(pattern);",
		expect: 'fire'
	},
	{
		id: 'NODE4',
		file: 'src/files.ts',
		source: 'export const sandbox_glob = (name, pattern) => pattern.includes(name);',
		expect: 'fire'
	},
	{
		id: 'BOOT1',
		file: 'scripts/server.mjs',
		source: "const environment = process.env; loadEnvFile('.env');",
		expect: 'fire'
	},
	{
		id: 'BOOT1',
		file: 'scripts/server.mjs',
		source: "function hydrate() { loadEnvFile('.env'); } const port = process.env.PORT; hydrate();",
		expect: 'fire'
	},
	{
		id: 'BOOT1',
		file: 'scripts/server.mjs',
		source: "const port = (() => process.env.PORT)(); loadEnvFile('.env');",
		expect: 'fire'
	},
	{
		id: 'BOOT1',
		file: 'scripts/server.mjs',
		source: "function hydrate() { loadEnvFile('.env'); } hydrate(); const environment = process.env;",
		expect: 'quiet'
	},
	{
		id: 'A1',
		file: 'src/probe.ts',
		source: 'export function start() { setTimeout(tick, 0); }',
		expect: 'fire'
	},
	{
		id: 'A1',
		file: 'src/probe.ts',
		source: 'export const f = () => { void setTimeout(tick, 10); };',
		expect: 'fire'
	},
	{
		id: 'A1',
		file: 'src/probe.ts',
		source: 'export const f = () => { this.timer = setInterval(tick, 10); };',
		expect: 'quiet'
	},
	{
		id: 'A1',
		file: 'src/probe.ts',
		source: 'export const f = () => ({ id: setTimeout(tick, 10) });',
		expect: 'quiet'
	},
	{
		id: 'A5',
		file: 'src/probe.ts',
		source: 'export class C { f() { try { go(); } catch (e) { throw e; } } }',
		expect: 'fire'
	},
	{
		id: 'A5',
		file: 'src/probe.ts',
		source: 'export async function f() { try { await go(); } catch (e) { throw e; } }',
		expect: 'fire'
	},
	{
		id: 'A5',
		file: 'src/probe.ts',
		source: 'export const f = () => { try { go(); } catch (e) { throw e.cause; } };',
		expect: 'quiet'
	},
	{
		id: 'A5',
		file: 'src/probe.ts',
		source: 'export const f = () => { try { go(); } catch (e) { if (e) throw e; } };',
		expect: 'quiet'
	},
	{
		id: 'A6',
		file: 'src/probe.ts',
		source: 'export async function f(n) { for (let i = 0; i < n; i++) await go(i); }',
		expect: 'fire'
	},
	{
		id: 'A6',
		file: 'src/probe.ts',
		source: 'export async function f(n) { let i = 0; while (i < n) { await go(i); i++; } }',
		expect: 'fire'
	},
	{
		id: 'A6',
		file: 'src/probe.ts',
		source: 'export async function f(obj) { for (const k in obj) await go(k); }',
		expect: 'fire'
	},
	{
		id: 'A6',
		file: 'src/probe.ts',
		source: 'export async function f() { do { await go(); } while (again); }',
		expect: 'fire'
	},
	{
		id: 'A6',
		file: 'src/probe.ts',
		source: 'export async function f(xs) { for (const x of xs) queue(x); await flush(); }',
		expect: 'quiet'
	},
	{
		id: 'AL1',
		file: 'src/probe.ts',
		source: 'export type Handle = Id;',
		expect: 'fire'
	},
	{
		id: 'AL1',
		file: 'src/probe.ts',
		source: 'type Row = Record;\nexport type Item = Row;',
		expect: 'fire'
	},
	{
		id: 'AL1',
		file: 'src/probe.ts',
		source: 'export type Handle = Id | null;',
		expect: 'quiet'
	},
	{
		id: 'AL1',
		file: 'src/probe.ts',
		source: 'export type Handle = readonly Id[];',
		expect: 'quiet'
	},
	{
		id: 'AL2',
		file: 'src/probe.ts',
		source: 'export type Name = string;',
		expect: 'fire'
	},
	{
		id: 'AL2',
		file: 'src/probe.ts',
		source: 'export type Flag = boolean;',
		expect: 'fire'
	},
	{
		id: 'AL2',
		file: 'src/probe.ts',
		source: 'export type Name = string | number;',
		expect: 'quiet'
	},
	{
		id: 'AL2',
		file: 'src/probe.ts',
		source: 'export type Name = ReadonlyArray<string>;',
		expect: 'quiet'
	},
	{
		id: 'AL3',
		file: 'src/probe.ts',
		source: 'export type Payload = Readonly<Record<string, unknown>>;',
		expect: 'fire'
	},
	{
		id: 'AL3',
		file: 'src/probe.ts',
		source: 'type State = Record<string, unknown>;',
		expect: 'fire'
	},
	{
		id: 'AL3',
		file: 'src/probe.ts',
		source: 'export type Payload = Record<string, string>;',
		expect: 'quiet'
	},
	{
		id: 'AL3',
		file: 'src/probe.ts',
		source: 'export type Payload = Map<string, unknown>;',
		expect: 'quiet'
	},
	{
		id: 'AL8',
		file: 'src/probe.ts',
		source: 'export type M = { role: string; parts: string };',
		expect: 'fire'
	},
	{
		id: 'AL8',
		file: 'src/probe.ts',
		source: "export const f = (m: { role: 'user'; content: string }) => m;",
		expect: 'fire'
	},
	{
		id: 'AL8',
		file: 'src/probe.ts',
		source: 'export const f = (m: { role: string; text: string }) => m;',
		expect: 'quiet'
	},
	{
		id: 'AL8',
		file: 'src/probe.ts',
		source: 'export interface M { role: string; content: string }',
		expect: 'quiet'
	},
	{
		id: 'AL9',
		file: 'src/probe.ts',
		source:
			'export function save(row: { a: number; b: number; c: number; d: number; e: number }) { return row; }',
		expect: 'fire'
	},
	{
		id: 'AL9',
		file: 'src/probe.ts',
		source: 'export const save = (input: { w: string; x: string; y: string; z: string }) => input;',
		expect: 'fire'
	},
	{
		id: 'AL9',
		file: 'src/probe.ts',
		source:
			'export class C { save(input: { a: string; b: string; c: string; d: string }) { return input; } }',
		expect: 'fire'
	},
	{
		id: 'AL9',
		file: 'src/probe.ts',
		source: 'export function save(input: { a: string; b: string }) { return input; }',
		expect: 'quiet'
	},
	{
		id: 'AL9',
		file: 'src/probe.ts',
		source: 'export function save({ a, b, c, d }: Options) { return a; }',
		expect: 'quiet'
	},
	{
		id: 'D2',
		file: 'src/probe.ts',
		source: 'export const v = cond ? name : name;',
		expect: 'fire'
	},
	{
		id: 'D2',
		file: 'src/probe.ts',
		source: 'export const v = cond ? foo() : foo();',
		expect: 'fire'
	},
	{
		id: 'D2',
		file: 'src/probe.ts',
		source: 'export const v = cond ? foo(1) : foo(1);',
		expect: 'fire'
	},
	{
		id: 'D2',
		file: 'src/probe.ts',
		source: 'export const v = cond ? foo() : bar();',
		expect: 'quiet'
	},
	{
		id: 'E1',
		file: 'src/probe.ts',
		source: "export const v = process.env.NODE_ENV === 'production' ? a : b;",
		expect: 'fire'
	},
	{
		id: 'E1',
		file: 'src/probe.ts',
		source: "export const v = process.env['PUBLIC_MODE'] === 'live' ? a : b;",
		expect: 'fire'
	},
	{
		id: 'E1',
		file: 'src/probe.ts',
		source: "if (process.env.SECRET_MODE === 'live') { run(); }",
		expect: 'fire'
	},
	{
		id: 'E1',
		file: 'src/probe.ts',
		source: "export const v = process.env['SECRET_URL'];",
		expect: 'quiet'
	},
	{
		id: 'E1',
		file: 'src/probe.ts',
		source: 'export const v = process.env.NORBITAL_HOME;',
		expect: 'quiet'
	},
	{
		id: 'IMP1',
		file: 'src/lib/deep/probe.ts',
		fixture: { 'tsconfig.json': '{"compilerOptions":{"paths":{"#lib/*":["./src/lib/*"]}}}' },
		source: "import { v } from '../../lib/value.js';\nexport const x = v;",
		expect: 'fire'
	},
	{
		id: 'IMP1',
		file: 'src/feature/panel/probe.ts',
		fixture: {
			'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "#lib/*": ["src/lib/*"] } } }',
			'src/lib/value.ts': 'export const v = 1;'
		},
		source: "import { v } from '../../vendor/value.js';\nexport const x = v;",
		expect: 'quiet'
	},
	{
		id: 'IMP1',
		file: 'src/feature/panel/probe.ts',
		source: "import { v } from '../../lib/value.js';\nexport const x = v;",
		expect: 'quiet'
	},
	{
		id: 'P9',
		file: 'src/probe.ts',
		source: "export * from 'node:fs';",
		expect: 'fire'
	},
	{
		id: 'P9',
		file: 'src/probe.ts',
		source: 'export * from "#lib/x.js";',
		expect: 'fire'
	},
	{
		id: 'P9',
		file: 'src/probe.ts',
		source: "export * as ns from './other.js';",
		expect: 'quiet'
	},
	{
		id: 'P9',
		file: 'src/probe.ts',
		source: "export { default } from './x.js';",
		expect: 'quiet'
	},
	{
		id: 'PERF3',
		file: 'src/probe.ts',
		source: 'export const f = (xs) => xs.filter(a).map(b).sort(c);',
		expect: 'fire'
	},
	{
		id: 'PERF3',
		file: 'src/probe.ts',
		source: 'export const f = (xs) => xs.reduce(a).slice(b).concat(c);',
		expect: 'fire'
	},
	{
		id: 'PERF3',
		file: 'src/probe.ts',
		source: 'export const f = (xs) => xs.map(a).filter(b).forEach(c);',
		expect: 'fire'
	},
	{
		id: 'PERF3',
		file: 'src/probe.ts',
		source: "export const f = (xs) => xs.map(a).filter(b).join(',');",
		expect: 'quiet'
	},
	{
		id: 'S1',
		file: 'src/probe.ts',
		source: 'export const f = () => { try { go(); } catch (e) {} };',
		expect: 'fire'
	},
	{
		id: 'S1',
		file: 'src/probe.ts',
		source: 'export const f = () => { try { go(); } catch { return; } };',
		expect: 'fire'
	},
	{
		id: 'S1',
		file: 'src/probe.ts',
		source: 'export const f = () => { try { go(); } catch { throw cause; } };',
		expect: 'quiet'
	},
	{
		id: 'S1',
		file: 'src/probe.ts',
		source: 'export const f = () => { try { go(); } catch { console.log(1); } };',
		expect: 'quiet'
	},
	{
		id: 'V6',
		file: 'src/probe.ts',
		source: 'export const f = () => { (async function () { await go(); })(); };',
		expect: 'fire'
	},
	{
		id: 'V6',
		file: 'src/probe.ts',
		source: 'export const f = () => { void (async () => await go())(); };',
		expect: 'fire'
	},
	{
		id: 'V6',
		file: 'src/probe.ts',
		source: 'export const f = async function () { await go(); };',
		expect: 'quiet'
	},
	{
		id: 'V6',
		file: 'src/probe.ts',
		source: 'export const f = () => { queueMicrotask(async () => { await go(); }); };',
		expect: 'quiet'
	}
];

function observationsFor(id: string, docs: ReadonlyMap<string, Documented>): ReadonlyArray<Observation> {
	const document = docs.get(id);
	const fromYaml: Array<Observation> = [];
	if (document !== undefined) {
		for (const source of document.bad)
			fromYaml.push({
				id,
				source,
				expect: 'fire',
				file: document.file,
				fixture: document.fixture
			});
		for (const source of document.good)
			fromYaml.push({
				id,
				source,
				expect: 'quiet',
				file: document.file,
				fixture: document.fixture
			});
	}
	return [...fromYaml, ...EXTRAS.filter((row) => row.id === id)];
}

function fires(rule: Rule, observation: Observation): boolean {
	const file = observation.file ?? 'src/probe.ts';
	const root = mkdtempSync(join(tmpdir(), 'doctor-d8-'));
	try {
		const files: Record<string, string> = { ...(observation.fixture ?? {}), [file]: observation.source };
		writeFileSync(join(root, 'package.json'), '{"name":"doctor-d8","type":"module"}');
		for (const [path, contents] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), contents);
		}
		return runRules({ root, rules: [rule], files: Object.keys(files) }).some(
			(finding) => finding.rule === rule.id
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

type Verdict = Readonly<{
	id: string;
	observations: number;
	failures: ReadonlyArray<string>;
	proven: boolean;
}>;

function meetsFloor(observations: number, failures: number): boolean {
	return observations >= FLOOR && failures === 0;
}

function judge(docs: ReadonlyMap<string, Documented>): ReadonlyArray<Verdict> {
	return STRUCTURE_53.map((id) => {
		const rule = structureRules.find((candidate) => candidate.id === id);
		assert.ok(rule !== undefined, `${id} is not in the structure pack`);
		const observations = observationsFor(id, docs);
		const failures: Array<string> = [];
		for (const observation of observations) {
			const reported = fires(rule, observation);
			if (observation.expect === 'fire' && !reported)
				failures.push(`${id} did not fire on ${observation.source.slice(0, 72)}`);
			if (observation.expect === 'quiet' && reported)
				failures.push(`${id} fired on ${observation.source.slice(0, 72)}`);
		}
		return {
			id,
			observations: observations.length,
			failures,
			proven: meetsFloor(observations.length, failures.length)
		};
	});
}

const verdicts = judge(documented());

test('the harness refuses a verdict below three discriminating observations', () => {
	assert.equal(meetsFloor(2, 0), false);
	assert.equal(meetsFloor(FLOOR, 0), true);
	assert.equal(meetsFloor(FLOOR, 1), false);
	for (const verdict of verdicts)
		assert.equal(
			verdict.proven,
			meetsFloor(verdict.observations, verdict.failures.length),
			`${verdict.id} proven=${verdict.proven} on ${verdict.observations}`
		);
});

test('every leftover structure rule with a discriminating harness is proven', () => {
	const leftover = verdicts.filter((verdict) => (LEFTOVER as ReadonlyArray<string>).includes(verdict.id));
	const failures = leftover.flatMap((verdict) => verdict.failures);
	assert.deepEqual(failures, [], failures.join('\n'));
	const proven = leftover.filter((verdict) => verdict.proven).map((verdict) => verdict.id);
	for (const id of LEFTOVER)
		assert.ok(proven.includes(id), `${id} has extras and must prove`);
});

test('first-sweep structure rules keep their existing proofs', () => {
	const failures = verdicts
		.filter((verdict) => !(LEFTOVER as ReadonlyArray<string>).includes(verdict.id))
		.flatMap((verdict) => verdict.failures);
	assert.deepEqual(failures, [], failures.join('\n'));
});

/** Visitor-era extras, not YAML-count paper. */
const MOVED = ['POLICY1', 'OPS1', 'NODE2', 'Q3', 'COMPLEX1', 'PERF2', 'Q4'] as const;

/** First-sweep ids this pass moves with extras that fire/quiet differently from YAML examples. */
const FIRST_SWEEP_MOVED = [
	'A1',
	'A5',
	'A6',
	'AL1',
	'AL2',
	'AL3',
	'AL8',
	'AL9',
	'BOOT1',
	'D2',
	'E1',
	'IMP1',
	'MOD1',
	'NODE1',
	'NODE3',
	'NODE4',
	'P9',
	'PERF3',
	'S1',
	'V6'
] as const;

test('leftover structure rules with visitor-era extras are the ones that move', () => {
	const moved = verdicts.filter((verdict) => (MOVED as ReadonlyArray<string>).includes(verdict.id));
	assert.deepEqual(
		moved.map((verdict) => verdict.id).sort(),
		[...MOVED].sort()
	);
	for (const verdict of moved)
		assert.ok(
			verdict.proven && verdict.observations >= FLOOR,
			`${verdict.id} has ${verdict.observations} observations`
		);
	const q4 = verdicts.find((verdict) => verdict.id === 'Q4');
	assert.ok(q4 !== undefined);
	assert.ok(q4.observations > 3, 'Q4 extras are more than the YAML-example floor');
});

test('first-sweep structure rules with visitor-era extras are the ones that move', () => {
	const extrasById = new Map<string, number>();
	for (const extra of EXTRAS)
		extrasById.set(extra.id, (extrasById.get(extra.id) ?? 0) + 1);
	for (const id of FIRST_SWEEP_MOVED) {
		const verdict = verdicts.find((row) => row.id === id);
		assert.ok(verdict !== undefined, `${id} is missing`);
		assert.ok(
			verdict.proven && (extrasById.get(id) ?? 0) >= FLOOR,
			`${id} has ${verdict.observations} observations and ${extrasById.get(id) ?? 0} extras`
		);
	}
});
