/**
 * The YAML authoring surface.
 *
 * Translation must be lossless in both directions that matter: a `rule` written in YAML behaves
 * exactly like the same matcher handed to the engine from TypeScript, and a `detect`/`prefer` pair
 * behaves exactly like the equivalent `overlapRules` binding. Everything else is strictness — a
 * bad field, a bad principle, a bad glob or a duplicate id throws with the file named, because
 * "zero findings" has to mean "clean" and never "misconfigured".
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
// The suite runs after `pnpm build`, so translation targets are imported as built modules —
// exactly how every authored rule reaches the engine.
import {
	matchSource,
	overlapRules,
	runRules,
	type Matcher
} from '../build/index.js';
import { loadPatternFiles } from '../build/patterns-yaml.js';

const PACKAGE_ROOT = join(import.meta.dirname, '..');
const FIXTURES = join(PACKAGE_ROOT, 'tests', 'fixtures', 'patterns');

/** A throwaway repository; no git needed, since pattern loading walks and runs take explicit files. */
function repository(name: string, files: Readonly<Record<string, string>>): string {
	const root = mkdtempSync(join(tmpdir(), `patterns-yaml-${name}-`));
	for (const [file, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), contents);
	}
	return root;
}

/** The rule object as the YAML file states it, before any translation. */
function described(file: string): Readonly<Record<string, unknown>> {
	return parseYaml(readFileSync(join(FIXTURES, file), 'utf8')) as Readonly<Record<string, unknown>>;
}

test('a rule.pattern translates into the matcher it names', () => {
	const raw = described('raw-fetch.yml').rule as Matcher;
	assert.equal(matchSource(raw, "await fetch('/api/items', { cache: 'no-store' });"), true);
	assert.equal(matchSource(raw, "await client.fetch('/api/items');"), false);
});

test('a relational inside rule reads through YAML unchanged', () => {
	const looped = described('looped-await.yml').rule as Matcher;
	assert.equal(
		matchSource(
			looped,
			'for (let i = 0; i < rows.length; i++) { parts.push(await load(rows[i])); }'
		),
		true
	);
	assert.equal(matchSource(looped, 'while (pending) { await settle(); }'), false);
});

test('a relational has rule finds the call anywhere in the function body', () => {
	const exported = described('function-fetch.yml').rule as Matcher;
	assert.equal(
		matchSource(exported, 'export function boot(): void {\n\tfetch("/health");\n}'),
		true
	);
	assert.equal(
		matchSource(exported, 'export function boot(): void {\n\tclient.fetch("/health");\n}'),
		false
	);
});

test('every fixture loads once, with absolute sources for receipts', async () => {
	const loaded = await loadPatternFiles(PACKAGE_ROOT, 'tests/fixtures/patterns/*.yml');
	assert.deepEqual(
		loaded.rules.map((rule) => rule.id).sort(),
		['CLAMPKIT', 'EXPORTEDFETCH', 'HYBRIDSQL', 'LOOPEDAWAIT', 'RAWFETCH', 'SEMRETRY']
	);
	assert.equal(loaded.sources.length, 6);
	assert.ok(loaded.sources.every((source) => isAbsolute(source)));
});

test('pseudocode halves become queries; defaults apply where no threshold is stated', async () => {
	const loaded = await loadPatternFiles(PACKAGE_ROOT, 'tests/fixtures/patterns/*.yml');

	const retry = loaded.queries.find((query) => query.ruleId === 'SEMRETRY');
	assert.ok(retry !== undefined);
	assert.equal(retry.threshold, 0.84);
	assert.match(retry.text, /backoff/);

	const hybrid = loaded.queries.find((query) => query.ruleId === 'HYBRIDSQL');
	assert.ok(hybrid !== undefined);
	assert.equal(hybrid.threshold, 0.7);

	// Both halves of a combined rule arrive: the structural rule above and its query beside it.
	assert.ok(loaded.rules.some((rule) => rule.id === 'HYBRIDSQL'));
});

test('a pseudocode-only rule lands in the catalogue but never fires structurally', async (context) => {
	const root = repository('inert', {
		'src/index.ts': 'export const run = (): number => 1;\n'
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const loaded = await loadPatternFiles(
		PACKAGE_ROOT,
		'tests/fixtures/patterns/semantic-retry.yml'
	);
	const findings = runRules({ root, rules: loaded.rules, files: ['src/index.ts'] });
	assert.equal(findings.filter((finding) => finding.rule === 'SEMRETRY').length, 0);
});

test('a loaded yaml rule reports against a repository like an authored one', async (context) => {
	const root = repository('fires', {
		'patterns/raw.yml':
			'id: TMPRAW\nsummary: raw fetch bypasses the http client\nseverity: error\nprinciples: [modularity]\nrule: fetch($...ARGS)\n',
		'patterns/hybrid.yml':
			'id: TMPHYBRID\nsummary: sql assembled as text\nseverity: error\nprinciples: [type-safety]\nrule: query($SQL)\npseudocode: sql built from concatenated strings\nthreshold: 0.7\n',
		'src/app.ts': `await fetch('/api/items');\nquery('SELECT * FROM users');\n`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const loaded = await loadPatternFiles(root, '**/*.yml');
	assert.deepEqual(loaded.queries.map((query) => query.ruleId), ['TMPHYBRID']);

	const findings = runRules({ root, rules: loaded.rules, files: ['src/app.ts'] });
	assert.deepEqual(
		[...new Set(findings.map((finding) => finding.rule))].sort(),
		['TMPHYBRID', 'TMPRAW']
	);
});

test('detect/prefer behaves identically to overlapRules on the same repository', async (context) => {
	const source =
		'export const clip = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);\n';
	const root = repository('clamp', {
		'patterns/clamp.yml':
			'id: TMPCLAMP\nsummary: local clamp reimplements es-toolkit#clamp\nseverity: error\nprinciples: [simplicity, efficiency]\ndetect: clamp\nprefer: es-toolkit#clamp\n',
		'src/math.ts': source
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const loaded = await loadPatternFiles(root, 'patterns/clamp.yml');
	const viaYaml = runRules({ root, rules: loaded.rules, files: ['src/math.ts'] }).filter(
		(finding) => finding.rule === 'TMPCLAMP'
	);
	const direct = runRules({
		root,
		rules: overlapRules([
			{ shape: 'clamp', owner: 'es-toolkit', member: 'clamp', severity: 'error', id: 'TMPCLAMP' }
		]),
		files: ['src/math.ts']
	}).filter((finding) => finding.rule === 'TMPCLAMP');

	assert.ok(viaYaml.length >= 1);
	assert.deepEqual(
		viaYaml.map((finding) => `${finding.rule} ${finding.location}`),
		direct.map((finding) => `${finding.rule} ${finding.location}`)
	);
});

test('module reaches the detector, so the evidence names the qualified owner', async (context) => {
	const root = repository('module', {
		'patterns/equal.yml':
			"id: TMPEQUAL\nsummary: json comparison reimplements @acme/std#deepEqual\nseverity: error\nprinciples: [type-safety]\ndetect: deep-equal\nprefer: '@acme/std#deepEqual'\nmodule: compare\n",
		'src/same.ts':
			'export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);\n'
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const loaded = await loadPatternFiles(root, 'patterns/equal.yml');
	const findings = runRules({ root, rules: loaded.rules, files: ['src/same.ts'] });
	assert.equal(findings.length, 1);
	assert.match(
		findings[0]?.location ?? '',
		/\[shape=deep-equal prefer=@acme\/std\/compare#deepEqual\]$/
	);
});

test('globs discover nested files and refuse to match nothing', async (context) => {
	const header = (id: string): string =>
		`id: ${id}\nsummary: described elsewhere\nseverity: error\nprinciples: [simplicity]\n`;
	const root = repository('globs', {
		'patterns/one.yml': `${header('GLOBONE')}rule: fetch($...ARGS)\n`,
		'patterns/nested/two.yml': `${header('GLOBTWO')}rule: query($SQL)\n`,
		'src/code.ts': "fetch('/x');\n"
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const nested = await loadPatternFiles(root, '**/*.yml');
	assert.equal(nested.sources.length, 2);
	assert.deepEqual(nested.rules.map((rule) => rule.id).sort(), ['GLOBONE', 'GLOBTWO']);

	const literal = await loadPatternFiles(root, 'patterns/nested/two.yml');
	assert.equal(literal.sources.length, 1);
	assert.ok(isAbsolute(literal.sources[0] ?? ''));

	await assert.rejects(
		() => loadPatternFiles(root, 'patterns/*.miss.yml'),
		/norbital-doctor: pattern "patterns\/\*\.miss\.yml" matched no rule files \(\.yaml\/\.yml\)/
	);
});

test('bad input throws naming the file and the problem', async (context) => {
	const plain = (id: string): string =>
		`id: ${id}\nsummary: described elsewhere\nseverity: error\nprinciples: [simplicity]\n`;
	const root = repository('invalid', {
		'patterns/unknown-field.yml': `${plain('BADUNK')}ruls: fetch($A)\n`,
		'patterns/missing-principles.yml': 'id: BADREQ\nsummary: x\nseverity: error\n',
		'patterns/foreign-principle.yml':
			'id: BADPRIN\nsummary: x\nseverity: error\nprinciples: [speed]\n',
		'patterns/threshold-range.yml': `${plain('BADRANGE')}pseudocode: something\nthreshold: 1.5\n`,
		'patterns/detect-without-prefer.yml': `${plain('BADDETECT')}detect: clamp\n`,
		'patterns/prefer-malformed.yml': `${plain('BADPREF')}detect: clamp\nprefer: es-toolkit\n`,
		'patterns/prefer-without-detect.yml': `${plain('BADLONE')}prefer: es-toolkit#clamp\n`,
		'patterns/unknown-shape.yml': `${plain('BADSHAPE')}detect: flatten\nprefer: es-toolkit#flatten\n`,
		'patterns/rule-and-detect.yml': `${plain('BADBOTH')}rule: fetch($A)\ndetect: clamp\nprefer: es-toolkit#clamp\n`,
		'patterns/when-with-rule.yml': `${plain('BADWHEN')}rule: fetch($A)\nwhen: [CallExpression]\n`,
		'patterns/unknown-kind.yml': `${plain('BADKIND')}pseudocode: something\nwhen: [CalExpression]\n`,
		'patterns/threshold-alone.yml': `${plain('BADALONE')}threshold: 0.5\n`,
		'patterns/bad-id.yml': 'id: 9BAD\nsummary: x\nseverity: error\nprinciples: [simplicity]\n',
		'patterns/bad-severity.yml': 'id: BADSEV\nsummary: x\nseverity: warn\nprinciples: [simplicity]\n',
		'patterns/self-dominates.yml': `${plain('BADDOM')}dominates: [BADDOM]\nrule: fetch($A)\n`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const rejects = async (name: string, problem: RegExp): Promise<void> =>
		assert.rejects(
			() => loadPatternFiles(root, `patterns/${name}.yml`),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.ok(
					error.message.startsWith(`norbital-doctor: patterns/${name}.yml:`),
					error.message
				);
				assert.match(error.message, problem);
				return true;
			}
		);

	await rejects('unknown-field', /unknown field "ruls"/);
	await rejects('missing-principles', /missing required field "principles"/);
	await rejects('foreign-principle', /"speed" is not a principle/);
	await rejects('threshold-range', /"threshold" must be a number between 0 and 1/);
	await rejects('detect-without-prefer', /"detect" requires "prefer"/);
	await rejects('prefer-malformed', /"prefer" must read owner#member/);
	await rejects('prefer-without-detect', /"prefer" belongs beside "detect"/);
	await rejects('unknown-shape', /"detect" must be one of/);
	await rejects('rule-and-detect', /two structural claims/);
	await rejects('when-with-rule', /"when" is decided by the matcher/);
	await rejects('unknown-kind', /"CalExpression" is not a syntax kind/);
	await rejects('threshold-alone', /"threshold" belongs beside "pseudocode"/);
	await rejects('bad-id', /is not a valid rule id/);
	await rejects('bad-severity', /"severity" must be "error" or "hint"/);
	await rejects('self-dominates', /cannot include the rule's own id/);
});

test('duplicate ids across two files throw naming the earlier declaration', async (context) => {
	const header = (id: string): string =>
		`id: ${id}\nsummary: described elsewhere\nseverity: error\nprinciples: [simplicity]\n`;
	const root = repository('duplicates', {
		'patterns/a.yml': `${header('DUPED')}rule: fetch($A)\n`,
		'patterns/b.yml': `${header('DUPED')}rule: query($SQL)\n`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	await assert.rejects(
		() => loadPatternFiles(root, 'patterns/*.yml'),
		/norbital-doctor: patterns\/b\.yml: rule id "DUPED" is already declared by patterns\/a\.yml/
	);
});
