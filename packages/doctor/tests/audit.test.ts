/**
 * An organization's rule set is data (§5 "Audit: rules are an organization's data", P19): one tree audited under three
 * rule sets — the defaults; a platform rule turned to a hint plus the organization's own rule; that rule off plus an
 * own rule that does not compile. An allowance kept with the code holds under each, and every result names its rule set.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { audit } from '../src/audit.ts';
import { DEFAULT_RULE_SET, ruleSetDigest, type AuditFinding, type RuleSet } from '../src/rule-set.ts';
const SCRIPT = '<script lang="ts">\n\tlet n = 4;\n</script>\n\n';
const TREE: Record<string, string> = {
	'src/bad.svelte': `${SCRIPT}<div class={\`mt-[\${n}px]\`}></div>\n`,
	'src/allowed.svelte': `${SCRIPT}<!-- repository-health:allow UI12 -- a reviewed exception kept with the code -->\n<div class={\`mt-[\${n}px]\`}></div>\n`,
	'src/log.ts': "export const trace = (x: number) => console.log('trace', x);\n",
	'vendor/log.ts': "export const vendored = (x: number) => console.log('vendored', x);\n"
};
const NO_CONSOLE = {
	id: 'NoConsoleLog',
	summary: 'console.log left in workspace code',
	severity: 'error',
	principles: ['simplicity'],
	files: ['**/*.ts'],
	rule: { pattern: 'console.log($$$A)' },
	examples: { bad: ["console.log('x')"], good: ["log('x')"] }
};
const SETS: Record<string, RuleSet> = {
	defaults: DEFAULT_RULE_SET,
	relaxed: { states: { UI12: 'hint' }, ignore: ['vendor/**'], rules: [NO_CONSOLE] },
	strict: {
		states: { UI12: 'off' },
		ignore: [],
		rules: [
			{ id: 'Broken', summary: 'no examples', severity: 'error', principles: ['simplicity'] },
			NO_CONSOLE
		]
	}
};
const tree = () => {
	const root = mkdtempSync(join(tmpdir(), 'doctor-audit-'));
	for (const [path, text] of Object.entries(TREE)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
};
const snapshot = (root: string) =>
	Object.keys(TREE).map((path) => readFileSync(join(root, path), 'utf8'));
const has = (findings: ReadonlyArray<AuditFinding>, rule: string, file: string) =>
	findings.find((finding) => finding.rule === rule && finding.location.startsWith(`${file}:`))
		?.severity;

it.effect(
	'each organization audits the same tree under its own rules, and an allowance holds under all of them',
	() =>
		Effect.sync(() => {
			const root = tree();
			try {
				const before = snapshot(root);
				const run = (set: RuleSet) => {
					const events = audit({ root, ruleSet: set });
					return {
						findings: events.filter((e): e is AuditFinding => e.type === 'finding'),
						errors: events.flatMap((e) => (e.type === 'rule-error' ? [e.id] : [])),
						rules: events.flatMap((e) => (e.type === 'rule' ? [e] : [])),
						done: events.at(-1)
					};
				};
				const defaults = run(SETS.defaults!),
					relaxed = run(SETS.relaxed!),
					strict = run(SETS.strict!);
				assert.equal(has(defaults.findings, 'UI12', 'src/bad.svelte'), 'error');
				assert.equal(has(defaults.findings, 'NoConsoleLog', 'src/log.ts'), undefined);
				assert.equal(has(relaxed.findings, 'UI12', 'src/bad.svelte'), 'hint');
				assert.equal(has(relaxed.findings, 'NoConsoleLog', 'src/log.ts'), 'error');
				// the organization's path scope: nothing under vendor/ is audited
				assert.equal(has(relaxed.findings, 'NoConsoleLog', 'vendor/log.ts'), undefined);
				assert.equal(has(strict.findings, 'UI12', 'src/bad.svelte'), undefined);
				assert.equal(has(strict.findings, 'NoConsoleLog', 'vendor/log.ts'), 'error');
				assert.deepEqual(strict.errors, ['Broken']);
				for (const result of [defaults, relaxed, strict])
					assert.equal(has(result.findings, 'UI12', 'src/allowed.svelte'), undefined);
				// the catalogue names every rule's state there, the organization's own under its own pack
				assert.equal(strict.rules.find((rule) => rule.id === 'UI12')?.state, 'off');
				assert.equal(
					relaxed.rules.find((rule) => rule.id === 'NoConsoleLog')?.pack,
					'organization'
				);
				assert.match(relaxed.rules.find((rule) => rule.id === 'UI12')?.summary ?? '', /arbitrary/);
				const digests = [defaults, relaxed, strict].map((result) =>
					result.done?.type === 'done' ? result.done.digest : ''
				);
				assert.deepEqual(digests, [SETS.defaults!, SETS.relaxed!, SETS.strict!].map(ruleSetDigest));
				assert.equal(new Set(digests).size, 3);
				assert.deepEqual(snapshot(root), before);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		})
);

it.effect('an own rule may not take a platform rule id, and the rule set alone needs no tree', () =>
	Effect.sync(() => {
		const events = audit({
			root: tmpdir(),
			ruleSet: { states: {}, ignore: [], rules: [{ ...NO_CONSOLE, id: 'UI12' }] },
			findings: false
		});
		const refused = events.flatMap((e) => (e.type === 'rule-error' ? [e.message] : []));
		assert.equal(refused.length, 1);
		assert.match(refused[0] ?? '', /already declared/);
		assert.equal(events.filter((e) => e.type === 'finding').length, 0);
	})
);

it.effect('the digest ignores key order, and moves with any change of the rule set', () =>
	Effect.sync(() => {
		const a: RuleSet = { states: { UI5: 'off', UI12: 'hint' }, ignore: [], rules: [] };
		const b: RuleSet = { rules: [], ignore: [], states: { UI12: 'hint', UI5: 'off' } };
		assert.equal(ruleSetDigest(a), ruleSetDigest(b));
		assert.notEqual(ruleSetDigest(a), ruleSetDigest({ ...a, ignore: ['vendor/**'] }));
	})
);
