/**
 * The extension surface: authored rules, packs, and overlap bindings.
 *
 * These run against real repositories on disk rather than a mocked filesystem, because the whole
 * mechanism is discovery — a config found, a `.ts` module imported, git deciding which files are
 * sources. A fixture that stubbed any of that would prove something other than what ships.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
	defineRule,
	definePack,
	audit,
	assess,
	overlapRules,
	runRules,
	sourceFiles,
	loadConfig
} from '../build/index.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

function repository(name: string, files: Readonly<Record<string, string>>): string {
	const root = mkdtempSync(join(tmpdir(), `probe-${name}-`));
	for (const [file, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), contents);
	}
	execFileSync('git', ['init', '-q'], { cwd: root });
	execFileSync('git', ['add', '-A'], { cwd: root });
	return root;
}

test('an authored rule reports against real source and carries its own metadata', (context) => {
	const root = repository('authored', {
		'package.json': '{"name":"authored","type":"module"}',
		'src/a.ts': 'export const load = () => fetch("/api");\n',
		'src/b.ts': 'export const clean = () => 1;\n'
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const rule = defineRule({
		id: 'ACME1',
		severity: 'error',
		summary: 'raw fetch bypasses the http client',
		principles: ['straightforwardness', 'testability'],
		when: ['CallExpression'],
		check(node, ruleContext) {
			if (ruleContext.calleeName(node) !== 'fetch') return;
			ruleContext.report(node, 'callee=fetch');
		}
	});

	const findings = runRules({ root, rules: [rule] });
	assert.equal(findings.length, 1);
	assert.equal(findings[0]?.rule, 'ACME1');
	assert.equal(findings[0]?.severity, 'error');
	assert.equal(findings[0]?.confidence, 'high');
	assert.deepEqual(findings[0]?.principles, ['straightforwardness', 'testability']);
	assert.match(findings[0]?.location ?? '', /^src\/a\.ts:1: .*\[callee=fetch\]$/);
});

test('rule authoring is validated at definition, not at the first scan', () => {
	assert.throws(
		() =>
			defineRule({
				id: 'bad id',
				severity: 'error',
				summary: 's',
				principles: ['simplicity'],
				when: ['CallExpression'],
				check: () => undefined
			}),
		/rule id must be alphanumeric/
	);
	assert.throws(
		() =>
			defineRule({
				id: 'X1',
				severity: 'error',
				summary: 's',
				principles: ['simplicity'],
				when: ['NoSuchKind' as 'CallExpression'],
				check: () => undefined
			}),
		/unknown syntax kind/
	);
	assert.throws(
		() =>
			defineRule({
				id: 'X2',
				severity: 'error',
				summary: 's',
				principles: [],
				when: ['CallExpression'],
				check: () => undefined
			}),
		/at least one principle/
	);
	const rule = defineRule({
		id: 'X3',
		severity: 'error',
		summary: 's',
		principles: ['simplicity'],
		when: ['CallExpression'],
		check: () => undefined
	});
	assert.throws(() => definePack({ name: 'p', rules: [rule, rule] }), /declares rule X3 twice/);
});

test('overlap bindings name any owner, and an importer of that owner is exempt', (context) => {
	const root = repository('overlap', {
		'package.json': '{"name":"overlap","type":"module"}',
		'src/unaware.ts': 'export const c = (x: number) => Math.min(Math.max(x, 0), 10);\n',
		'src/aware.ts':
			'import { clamp } from "es-toolkit";\nexport const c = (x: number) => Math.min(Math.max(x, 0), 10);\nvoid clamp;\n'
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const rules = overlapRules([{ shape: 'clamp', owner: 'es-toolkit', member: 'clamp' }]);
	const findings = runRules({ root, rules });

	// Bound to es-toolkit, not Effect: the shape detector is library-agnostic.
	assert.equal(findings.length, 1);
	assert.match(findings[0]?.location ?? '', /^src\/unaware\.ts:/);
	assert.match(findings[0]?.location ?? '', /prefer=es-toolkit#clamp/);
	assert.equal(findings[0]?.rule, 'OVERLAP_CLAMP');

	// The same source is not reported where the owner is already imported.
	assert.ok(!findings.some((finding) => finding.location.startsWith('src/aware.ts')));

	assert.throws(
		() => overlapRules([{ shape: 'nope' as 'clamp', owner: 'x', member: 'y' }]),
		/unknown overlap shape/
	);
});

test('a config is discovered, imported without a build step, and composes packs', async (context) => {
	const root = repository('config', {
		'package.json': '{"name":"config","type":"module"}',
		'src/a.ts': 'export const load = () => fetch("/api");\n',
		'dr/rules/no-fetch.ts': `import { defineRule } from '${packageRoot}build/index.js';
export default defineRule({
	id: 'ACME1',
	severity: 'error',
	summary: 'raw fetch',
	principles: ['straightforwardness'],
	when: ['CallExpression'],
	check(node, context) {
		if (context.calleeName(node) === 'fetch') context.report(node);
	}
});
`,
		'dr/packs/house.ts': `import { definePack, defineRule } from '${packageRoot}build/index.js';
export default definePack({
	name: 'house',
	rules: [
		defineRule({
			id: 'HOUSE1',
			severity: 'warning',
			summary: 'debugger left in source',
			principles: ['no-bloat'],
			when: ['DebuggerStatement'],
			check(node, context) { context.report(node); }
		})
	]
});
`,
		'doctor.config.ts': `import { defineConfig } from '${packageRoot}build/index.js';
import noFetch from './dr/rules/no-fetch.ts';
export default defineConfig({ semantic: { disabled: true },
	rules: [noFetch],
	packs: ['./dr/packs/house.ts']
});
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const config = await loadConfig(root);
	assert.deepEqual(config.packs, ['house']);
	assert.deepEqual(config.rules.map((rule) => rule.id).sort(), ['ACME1', 'HOUSE1']);
});

test('a disabled rule is dropped and a duplicate id is refused', async (context) => {
	const root = repository('disable', {
		'package.json': '{"name":"disable","type":"module"}',
		'doctor.config.ts': `import { defineConfig } from '${packageRoot}build/index.js';
import { defineRule } from '${packageRoot}build/index.js';
const make = (id) => defineRule({
	id, severity: 'error', summary: 's', principles: ['simplicity'],
	when: ['CallExpression'], check() {}
});
export default defineConfig({ semantic: { disabled: true }, rules: [make('KEEP'), make('DROP')], disable: ['DROP'] });
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const config = await loadConfig(root);
	assert.deepEqual(
		config.rules.map((rule) => rule.id),
		['KEEP']
	);
});

test('a rule that throws becomes a finding rather than taking the audit down', (context) => {
	const root = repository('throwing', {
		'package.json': '{"name":"throwing","type":"module"}',
		'src/a.ts': 'export const x = go();\n'
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const rule = defineRule({
		id: 'BOOM',
		severity: 'error',
		summary: 'never reports',
		principles: ['simplicity'],
		when: ['CallExpression'],
		check() {
			throw new Error('detector defect');
		}
	});
	const findings = runRules({ root, rules: [rule] });
	assert.equal(findings.length, 1);
	assert.equal(findings[0]?.rule, 'RULE');
	assert.match(findings[0]?.location ?? '', /BOOM \[detector defect\]/);
});

test('file scoping and svelte script extraction select the right sources', (context) => {
	const root = repository('scope', {
		'package.json': '{"name":"scope","type":"module"}',
		'src/app.svelte': '<script lang="ts">\n\tconst r = fetch("/x");\n</script>\n<p>hi</p>\n',
		'src/only.ts': 'export const a = fetch("/y");\n',
		'src/other.ts': 'export const b = fetch("/z");\n',
		'node_modules/dep/index.ts': 'export const c = fetch("/ignored");\n'
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const rule = defineRule({
		id: 'F1',
		severity: 'error',
		summary: 'fetch',
		principles: ['simplicity'],
		when: ['CallExpression'],
		files: ['src/**'],
		ignore: ['src/other.ts'],
		check(node, ruleContext) {
			if (ruleContext.calleeName(node) === 'fetch') ruleContext.report(node);
		}
	});

	const findings = runRules({ root, rules: [rule] });
	const files = findings.map((finding) => finding.location.split(':')[0]).sort();
	assert.deepEqual(files, ['src/app.svelte', 'src/only.ts']);

	// The svelte finding keeps the line number of the original file, not of the extracted script.
	const component = findings.find((finding) => finding.location.startsWith('src/app.svelte'));
	assert.match(component?.location ?? '', /^src\/app\.svelte:2:/);

	// git-tracked discovery never reaches ignored trees.
	assert.ok(!sourceFiles(root).some((file) => file.startsWith('node_modules/')));
});

test('source discovery honors tests, path prefixes, and live .doctorignore edits', (context) => {
	const root = repository('source-options', {
		'package.json': '{"name":"source-options","type":"module"}',
		'.doctorignore': 'src/ignored.ts\n',
		'src/kept.ts': 'export const kept = 1;\n',
		'src/ignored.ts': 'export const ignored = 1;\n',
		'tests/kept.test.ts': 'export const tested = 1;\n'
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	assert.deepEqual(sourceFiles(root), ['src/kept.ts']);
	assert.deepEqual(sourceFiles(root, { includeTests: true, paths: ['tests'] }), [
		'tests/kept.test.ts'
	]);

	writeFileSync(join(root, '.doctorignore'), 'src/kept.ts\n');
	assert.deepEqual(sourceFiles(root), ['src/ignored.ts']);
});

test('source discovery needs neither git nor ripgrep outside a repository', (context) => {
	const root = mkdtempSync(join(tmpdir(), 'probe-portable-source-'));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, 'src'), { recursive: true });
	writeFileSync(join(root, 'src/index.ts'), 'export const value = 1;\n');
	mkdirSync(join(root, 'node_modules/ignored'), { recursive: true });
	writeFileSync(join(root, 'node_modules/ignored/index.ts'), 'export const ignored = 1;\n');

	const previousPath = process.env.PATH;
	try {
		process.env.PATH = '';
		assert.deepEqual(sourceFiles(root), ['src/index.ts']);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	}
});

test('authored-only evidence publishes a durable receipt that consolidated assessment authenticates', async (context) => {
	const root = repository('authored-evidence', {
		'package.json': '{"name":"authored-evidence","type":"module"}',
		// A script directory is a framework entrypoint, so the neutral baseline's reachability
		// check stays quiet and this fixture measures exactly the authored rule.
		'scripts/run.ts': 'export const load = () => fetch("/api");\n',
		'dr/rules/no-fetch.ts': `import { defineRule } from '${packageRoot}build/index.js';
export default defineRule({
	id: 'ACME1', severity: 'error', summary: 'raw fetch',
	principles: ['straightforwardness'], when: ['CallExpression'],
	check(node, context) { if (context.calleeName(node) === 'fetch') context.report(node); }
});
`,
		'doctor.config.ts': `import { defineConfig } from '${packageRoot}build/index.js';
import noFetch from './dr/rules/no-fetch.ts';
export default defineConfig({ semantic: { disabled: true }, rules: [noFetch] });
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const result = await audit({ root });
	assert.equal(result.status, 1);
	assert.equal(result.authoredFindings, 1);
	assert.equal(result.receipt.tiers.graph, true);
	assert.equal(result.receipt.counts.error, 1);
	assert.match(readFileSync(result.cataloguePath, 'utf8'), /\tACME1\t/);

	const consolidated = await assess({ roots: [root] });
	assert.equal(consolidated.status, 1);
	const report = JSON.parse(consolidated.report) as {
		quality: { totals: { error: number }; coverage: { tiers: { graph: boolean } } };
	};
	assert.equal(report.quality.totals.error, 1);
	assert.equal(report.quality.coverage.tiers.graph, true);
});

test('authored findings merge into the built-in authenticated catalogue', async (context) => {
	const root = repository('merged-evidence', {
		'package.json': '{"name":"merged-evidence","type":"module"}',
		'src/a.ts': 'export const value = 1;\n',
		'doctor.config.ts': `import { defineConfig, defineRule } from '${packageRoot}build/index.js';
export default defineConfig({ semantic: { disabled: true },
	rules: [defineRule({
		id: 'ACME_MERGE', severity: 'error', summary: 'authored merge fixture',
		principles: ['testability'], when: ['VariableDeclaration'], files: ['src/a.ts'],
		check(node, context) { context.report(node); }
	})]
});
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const result = await audit({ root });
	// The neutral baseline runs beneath the authored rule, so this is a merge rather than a
	// replacement: the authored finding is in the same catalogue as everything the baseline found.
	assert.ok(result.findings.some((finding) => finding.rule === 'ACME_MERGE'));
	assert.equal(result.receipt.tiers.graph, true);
	assert.match(readFileSync(result.cataloguePath, 'utf8'), /\tACME_MERGE\t/);
	assert.equal(result.receipt.counts.total, result.findings.length);
	assert.deepEqual(result.packs, []);
});

test('the dev-loop audit reloads an imported authored rule instead of reusing the ESM cache', async (context) => {
	const rulePath = 'dr/rules/no-fetch.ts';
	const root = repository('fresh-rules', {
		'package.json': '{"name":"fresh-rules","type":"module"}',
		// A script directory is a framework entrypoint, so the neutral baseline contributes
		// nothing here and the counts measure exactly the authored rule.
		'scripts/run.ts': 'export const load = () => fetch("/api");\n',
		[rulePath]: `import { defineRule } from '${packageRoot}build/index.js';
export default defineRule({
	id: 'FRESH1', severity: 'error', summary: 'first rule', principles: ['testability'],
	when: ['CallExpression'],
	check(node, context) { if (context.calleeName(node) === 'fetch') context.report(node); }
});
`,
		'doctor.config.ts': `import { defineConfig } from '${packageRoot}build/index.js';
import rule from './${rulePath}';
export default defineConfig({ semantic: { disabled: true }, rules: [rule] });
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	assert.equal((await audit({ root })).authoredFindings, 1);
	writeFileSync(
		join(root, rulePath),
		`import { defineRule } from '${packageRoot}build/index.js';
export default defineRule({
	id: 'FRESH1', severity: 'error', summary: 'second rule', principles: ['testability'],
	when: ['CallExpression'],
	check(node, context) { if (context.calleeName(node) === 'notFetch') context.report(node); }
});
`
	);
	assert.equal((await audit({ root })).authoredFindings, 0);
});

test('the default CLI command accepts options before an explicit command', (context) => {
	const root = repository('cli-default', {
		'package.json': '{"name":"cli-default","type":"module"}',
		// A script directory is a framework entrypoint, so the neutral baseline reports nothing
		// and a clean scan reads as clean.
		'scripts/run.ts': 'export const value = 1;\n',
		'doctor.config.ts': `import { defineConfig } from '${packageRoot}build/index.js';
export default defineConfig({ semantic: { disabled: true },});
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const output = execFileSync(
		process.execPath,
		[join(packageRoot, 'build/cli.js'), '--root', root, '--json'],
		{ encoding: 'utf8' }
	);
	const result = JSON.parse(output) as { root: string; status: number };
	assert.equal(result.root, root);
	assert.equal(result.status, 0);
});

test('a malformed receipt is an error, never a quietly empty result', async () => {
	const { decodeReceipt } = await import('../build/index.js');
	const valid = {
		schemaVersion: 6,
		kind: 'repository-health-static-receipt',
		scannerVersion: 26,
		root: '/tmp/x',
		scope: 'all',
		includeTests: false,
		tiers: { syntactic: true, graph: true, typeAware: false, semantic: false },
		files: 12,
		findings: 'findings.tsv',
		sourceInventoryDigest: 'sha256:0',
		ruleSetDigest: 'sha256:0',
		catalogueDigest: 'sha256:0',
		counts: {},
		complete: true
	};
	assert.equal(decodeReceipt(JSON.stringify(valid), 'r.json').files, 12);

	for (const [expected, text] of [
		[/not valid JSON/, 'half-written{'],
		[/not a receipt object/, '"a string"'],
		[/not a receipt object/, 'null'],
		[/records no tier coverage/, JSON.stringify({ ...valid, tiers: undefined })],
		[
			/no boolean "graph" tier/,
			JSON.stringify({ ...valid, tiers: { ...valid.tiers, graph: 'yes' } })
		],
		[/does not name its catalogue/, JSON.stringify({ ...valid, findings: 42 })],
		[/no valid source count/, JSON.stringify({ ...valid, files: 1.5 })],
		[/describes an incomplete scan/, JSON.stringify({ ...valid, complete: false })]
	] as ReadonlyArray<readonly [RegExp, string]>) {
		assert.throws(() => decodeReceipt(text, 'r.json'), expected, text.slice(0, 40));
	}
});

test('a path git lists but that is gone from disk does not abort the scan', (context) => {
	const root = repository('deleted', {
		'package.json': '{"name":"deleted","type":"module"}',
		'src/kept.ts': 'export const load = () => fetch("/api");\n',
		'src/removed.ts': 'export const gone = 1;\n'
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	// Staged, then deleted from the worktree: `git ls-files` still names it.
	rmSync(join(root, 'src/removed.ts'));

	const files = sourceFiles(root);
	assert.ok(files.includes('src/kept.ts'));
	assert.ok(!files.includes('src/removed.ts'), 'a path with no file is not a source');

	const rule = defineRule({
		id: 'KEEP1',
		severity: 'error',
		summary: 'raw fetch',
		principles: ['straightforwardness'],
		when: ['CallExpression'],
		check(node, ruleContext) {
			if (ruleContext.calleeName(node) === 'fetch') ruleContext.report(node);
		}
	});
	const findings = runRules({ root, rules: [rule] });
	assert.equal(findings.length, 1);
	assert.match(findings[0]?.location ?? '', /^src\/kept\.ts:/);
});

test('.doctorignore inherits exclusions from the ignore files a repository already has', (context) => {
	const root = repository('inherit', {
		'package.json': '{"name":"inherit","type":"module"}',
		'.gitignore': '# build output\nvendor/\n!vendor/keep.ts\n',
		'.prettierignore': 'legacy/\n',
		'.doctorignore': 'inherit: .gitignore .prettierignore .absent-file\nsrc/scoped.ts  KEEP1\n',
		'src/app.ts': 'export const a = fetch("/a");\n',
		'src/scoped.ts': 'export const b = fetch("/b");\n',
		'vendor/lib.ts': 'export const c = fetch("/c");\n',
		'vendor/keep.ts': 'export const d = fetch("/d");\n',
		'legacy/old.ts': 'export const e = fetch("/e");\n'
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const files = sourceFiles(root);
	assert.ok(files.includes('src/app.ts'));
	assert.ok(!files.some((file) => file.startsWith('vendor/')), 'inherited from .gitignore');
	assert.ok(!files.some((file) => file.startsWith('legacy/')), 'inherited from .prettierignore');
	// A `!` line in a borrowed file makes an artifact committable, not source; it is not honored.
	assert.ok(!files.includes('vendor/keep.ts'), 'a borrowed re-inclusion stays excluded');
	// A named file that does not exist is skipped rather than failing the scan.
	assert.ok(files.length > 0);

	// Rule-scoped lines still work alongside inherited ones.
	const rule = defineRule({
		id: 'KEEP1',
		severity: 'error',
		summary: 'raw fetch',
		principles: ['straightforwardness'],
		when: ['CallExpression'],
		check(node, ruleContext) {
			if (ruleContext.calleeName(node) === 'fetch') ruleContext.report(node);
		}
	});
	const reported = runRules({ root, rules: [rule] }).map(
		(finding) => finding.location.split(':')[0]
	);
	assert.deepEqual(reported, ['src/app.ts']);
});

test('.mts, .cts and .jsx are discovered like every other source extension', (context) => {
	const root = repository('extensions', {
		'package.json': '{"name":"extensions","type":"module"}',
		'src/a.ts': 'export const a = fetch("/a");\n',
		'src/b.mts': 'export const b = fetch("/b");\n',
		'src/c.cts': 'export const c = fetch("/c");\n',
		'src/d.jsx': 'export const d = fetch("/d");\n',
		'src/e.d.mts': 'export declare const e: number;\n'
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const files = sourceFiles(root);
	for (const name of ['src/a.ts', 'src/b.mts', 'src/c.cts', 'src/d.jsx'])
		assert.ok(files.includes(name), `${name} should be a source`);
	assert.ok(!files.includes('src/e.d.mts'), 'a declaration file is not a source');
});

test('a finding carries principles in canonical order whatever the rule declared', (context) => {
	const root = repository('principles', {
		'package.json': '{"name":"principles","type":"module"}',
		'src/a.ts': 'export const a = fetch("/a");\n'
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const rule = defineRule({
		id: 'ORDER1',
		severity: 'error',
		summary: 'declared out of canonical order on purpose',
		principles: ['no-bloat', 'efficiency', 'simplicity', 'testability'],
		when: ['CallExpression'],
		check(node, ruleContext) {
			if (ruleContext.calleeName(node) === 'fetch') ruleContext.report(node);
		}
	});
	const [finding] = runRules({ root, rules: [rule] });
	// The analyzer rejects a catalogue row whose principles are out of sequence, so the runner
	// normalizes rather than trusting the author.
	assert.deepEqual(finding?.principles, ['simplicity', 'testability', 'efficiency', 'no-bloat']);
});

test('stringly-typed rules flag open-domain identifiers and leave closed unions alone', async (context) => {
	const root = repository('stringly', {
		'package.json': '{"name":"stringly","type":"module"}',
		'src/index.ts': `type Role = 'user' | 'assistant';
declare const message: { role: Role };
declare const team: { name: string };
declare const user: { email: string };
declare const node: { kind: 'a' | 'b' };

// Closed domain: a new member is a compile error.
export const isAssistant = message.role === 'assistant';
export const isKindA = node.kind === 'a';
// Existence, not identity.
export const hasEmail = user.email !== '';
// Two runtime values assume nothing about either.
export const same = team.name === user.email;

// Open domain: renaming in the product silently breaks these.
export const canPublish = team.name === 'Engineering';
export const listed = ['Engineering', 'Ops'].includes(team.name);
export function route() {
	switch (team.name) {
		case 'Engineering':
			return 1;
		default:
			return 0;
	}
}
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const { stringlyPack } = await import('../build/index.js');
	const findings = runRules({ root, rules: stringlyPack.rules });
	const ids = findings.map((finding) => finding.rule).sort();
	assert.deepEqual(ids, ['STR1', 'STR2', 'STR3']);

	// The authorization subclass is called out, because that is the one that is a security bug
	// rather than a maintainability one.
	const gate = findings.find((finding) => finding.rule === 'STR1');
	assert.match(gate?.location ?? '', /class=hardcoded-authorization/);
	assert.match(gate?.location ?? '', /literal="Engineering"/);

	// Nothing was reported against the closed unions, the existence check, or the value comparison.
	for (const legal of ['isAssistant', 'isKindA', 'hasEmail', 'same'])
		assert.ok(
			!findings.some((finding) => finding.location.includes(legal)),
			`${legal} must not be reported`
		);
});

test('a config that cannot load is unusable evidence, not an empty scan', async (context) => {
	// There is no engine left to refuse a root. The equivalent failure is a config whose imports do
	// not resolve: reporting that as a clean scan would be the one outcome worse than reporting
	// nothing, because it reads as a pass.
	const root = repository('broken-config', {
		'package.json': '{"name":"broken-config","type":"module"}',
		'src/a.ts': 'export const a = 1;\n',
		'doctor.config.ts':
			"import { defineConfig } from '@norbital-ai/definitely-absent';\nexport default defineConfig({});\n"
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const { audit: run } = await import('../build/index.js');
	await assert.rejects(() => run({ root }), /could not load|Cannot find package/);
});

test('every EFF4 family the legacy detector carried still has a shape', async (context) => {
	// The legacy EFF4 covered six families: Number.clamp, Array.chunksOf, Array.partition,
	// Equivalence, Cache, RateLimiter. Deleting it must not quietly stop enforcing any of them.
	const { overlapRules } = await import('../build/index.js');
	const root = repository('eff4', {
		'package.json': '{"name":"eff4","type":"module"}',
		'src/clamp.ts': 'export const c = (x: number) => Math.min(Math.max(x, 0), 9);\n',
		'src/equal.ts':
			'export const e = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);\n',
		'src/cache.ts': `const store = new Map<string, number>();
export function memo(key: string): number {
	if (store.has(key)) return store.get(key)!;
	const value = compute(key);
	store.set(key, value);
	return value;
}
`,
		'src/throttle.ts': `let lastRun = 0;
export function tick(now: number): void {
	if (now - lastRun > 1000) {
		lastRun = now;
		work();
	}
}
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const rules = overlapRules([
		{ shape: 'clamp', owner: 'effect', module: 'Number', member: 'clamp' },
		{ shape: 'deep-equal', owner: 'effect', module: 'Equal', member: 'equals' },
		{ shape: 'cache', owner: 'effect', module: 'Cache', member: 'make' },
		{ shape: 'rate-limit', owner: 'effect', module: 'RateLimiter', member: 'make' }
	]);
	const byFile = new Set(
		runRules({ root, rules }).map((finding) => finding.location.split(':')[0])
	);
	for (const file of ['src/clamp.ts', 'src/equal.ts', 'src/cache.ts', 'src/throttle.ts'])
		assert.ok(byFile.has(file), `${file} must still be detected`);
});
