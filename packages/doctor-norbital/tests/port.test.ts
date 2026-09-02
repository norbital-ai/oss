/**
 * Port acceptance for the Norbital product rules: platform ownership plus Svelte laws.
 * Every rule reports source that must be reported and none reports source that must not.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { runRules, type Rule } from '@norbital-ai/doctor';
import { platformRules, svelteRules } from '../build/index.js';

const ALL: ReadonlyArray<Rule> = [...platformRules, ...svelteRules];

type Case = Readonly<{
	rule: string;
	bad: string;
	good: string;
	file?: string;
	fixture?: Readonly<Record<string, string>>;
}>;

const CASES: ReadonlyArray<Case> = [
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
		bad: "export const wipe = 'truncate things';",
		good: "export const disk = 'truncate -s 8G image';"
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
			'export const clock = setInterval(() => { currentTime = new Date(); }, 60_000);\n' +
			'export const watchdogPollMillis = 250;'
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
		file: 'src/ui/probe.ts',
		bad: 'export const f = () => transport.command({});',
		good: 'export const f = () => client.db.things.create({});'
	},
	{
		rule: 'LEGACY1',
		bad: '/** @deprecated use next */\nexport function old() { return 1; }',
		good:
			'/** Current. */\nexport function current() { return 1; }\n' +
			'/** Reads the `@deprecated` tag. */\nexport function reader() { return 2; }'
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
		good: 'export const n = row.name ?? row.preview;'
	},
	{
		rule: 'TRANS2',
		bad: 'export const n = row.name || row.previous;',
		good: 'export const changed = previous === undefined || previous.mode !== file.mode;'
	},
	{
		rule: 'ROOT1',
		bad: 'export const root = process.env.COLONY_DATA_DIRECTORY;',
		good: 'export const root = process.env.TENANT_SUBSTRATE_ROOT;'
	},
	{
		rule: 'E3',
		bad: "export const url = process.env['SECRET_URL'] ?? '';",
		good: 'export const url = config.secretUrl;'
	},
	{
		rule: 'E2',
		bad: 'export const ENABLE_BETA = true;',
		good: 'export const enableBeta = config.beta;'
	}
];

function scan(
	source: string,
	file: string,
	rules: ReadonlyArray<Rule>,
	fixture?: Readonly<Record<string, string>>
): ReadonlyArray<string> {
	const root = mkdtempSync(join(tmpdir(), 'doctor-norbital-port-'));
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
		assert.ok(rule !== undefined, `${testCase.rule} is not in a Norbital pack`);
		if (!scan(testCase.bad, file, [rule], testCase.fixture).includes(testCase.rule))
			missing.push(`${testCase.rule}: no finding for ${testCase.bad.replace(/\n/g, ' ').slice(0, 60)}`);
	}
	assert.deepEqual(missing, [], missing.join('\n'));
});

test('no ported rule reports its negative example', () => {
	const spurious: Array<string> = [];
	for (const testCase of CASES) {
		const file = testCase.file ?? 'src/probe.ts';
		const rule = ALL.find((candidate) => candidate.id === testCase.rule);
		assert.ok(rule !== undefined, `${testCase.rule} is not in a Norbital pack`);
		if (scan(testCase.good, file, [rule], testCase.fixture).includes(testCase.rule))
			spurious.push(`${testCase.rule}: reported ${testCase.good.replace(/\n/g, ' ').slice(0, 60)}`);
	}
	assert.deepEqual(spurious, [], spurious.join('\n'));
});

test('every non-component Norbital rule has a port case', () => {
	const covered = new Set(CASES.map((testCase) => testCase.rule));
	const componentOnly = new Set(svelteRules.map((rule) => rule.id));
	const uncovered = ALL.map((rule) => rule.id).filter(
		(id) => !covered.has(id) && !componentOnly.has(id)
	);
	assert.deepEqual(uncovered, [], `no port case for: ${uncovered.join(' ')}`);
});
