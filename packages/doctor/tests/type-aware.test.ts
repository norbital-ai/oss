/**
 * The type-aware tier, and the per-line allowances every tier answers to.
 *
 * Both are about the difference between "looked and found nothing" and "never looked". The tier
 * exists because a `@deprecated` tag usually lives in somebody else's `.d.ts`, where no syntactic
 * rule can see it; the allowance pass exists because a reviewed exception that stops suppressing is
 * indistinguishable from new debt.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { audit } from '../build/index.js';

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

const TSCONFIG = JSON.stringify({
	compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', strict: true }
});

const LEGACY_MODULE = `/** @deprecated call \`fresh\` instead. */
export function stale(): number {
	return 1;
}

export function keep(value: number): number;
/** @deprecated pass a number. */
export function keep(value: boolean): number;
export function keep(value: number | boolean): number {
	return typeof value === 'number' ? value : 0;
}

/** @deprecated use \`Fresh\`. */
export type Stale = Readonly<{ id: number }>;

export type Fresh = Readonly<{ id: number }>;
`;

const rules = (findings: ReadonlyArray<{ rule: string }>, id: string): number =>
	findings.filter((finding) => finding.rule === id).length;

test('the type-aware tier resolves the overload that was called, not the symbol', async (context) => {
	const root = repository('type-aware-overload', {
		'package.json': '{"name":"ta","type":"module","exports":"./src/main.ts"}',
		'tsconfig.json': TSCONFIG,
		'src/legacy.ts': LEGACY_MODULE,
		// `keep(1)` selects the live overload. A symbol-level check would report it, because the
		// symbol carries a deprecated declaration among its three — that is the false-positive
		// family this rule exists to avoid.
		'src/main.ts': `import { keep } from './legacy.js';

export const live = (): number => keep(1);
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const result = await audit({ root });
	assert.equal(result.receipt.tiers.typeAware, true);
	assert.equal(rules(result.findings, 'LEGACY2'), 0);
});

test('a deprecated signature, function and type each report once through the import', async (context) => {
	const root = repository('type-aware-reports', {
		'package.json': '{"name":"ta","type":"module","exports":"./src/main.ts"}',
		'tsconfig.json': TSCONFIG,
		'src/legacy.ts': LEGACY_MODULE,
		'src/main.ts': `import { stale, keep, type Stale } from './legacy.js';

export const one = (): number => stale();
export const two = (): number => keep(true);
export const three = (value: Stale): number => value.id;
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const result = await audit({ root });
	const found = result.findings.filter((finding) => finding.rule === 'LEGACY2');
	assert.equal(found.length, 3);
	assert.match(found[0]?.location ?? '', /^src\/main\.ts:3: .*\[symbol=stale declared=/);
	assert.match(found[1]?.location ?? '', /^src\/main\.ts:4: .*\[symbol=keep declared=/);
	assert.match(found[2]?.location ?? '', /^src\/main\.ts:5: .*\[symbol=Stale declared=/);
	for (const finding of found) assert.equal(finding.severity, 'error');
	// The declaration site is `LEGACY1`'s business. Reporting it here would count one debt twice.
	assert.equal(
		found.some((finding) => finding.location.startsWith('src/legacy.ts')),
		false
	);
});

test('a repository with no program source says the tier did not run rather than reporting clean', async (context) => {
	const root = repository('type-aware-empty', {
		'package.json': '{"name":"ta","type":"module"}',
		'src/only.svelte': '<script>\n\tlet count = 0;\n</script>\n\n<p>{count}</p>\n'
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const result = await audit({ root });
	// `.svelte` is outside the tier: the compiler cannot put a component in a program. The flag
	// reports that honestly instead of claiming coverage the tier does not have.
	assert.equal(result.receipt.tiers.typeAware, false);
});

test('an exact, reasoned allowance suppresses its rule and nothing else', async (context) => {
	const root = repository('allowance-exact', {
		'package.json': '{"name":"al","type":"module","exports":"./src/main.ts"}',
		'doctor.config.ts': `import { defineConfig } from '@norbital-ai/doctor';
export default defineConfig({ packs: ['norbital'] });
`,
		'src/main.ts': `export const speak = (): void => {
	// repository-health:allow LOG1 -- this CLI writes its report to stdout by contract
	console.log('report');
	console.log('unreviewed');
};
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const result = await audit({ root });
	const found = result.findings.filter((finding) => finding.rule === 'LOG1');
	assert.equal(found.length, 1);
	assert.match(found[0]?.location ?? '', /^src\/main\.ts:4: /);
});

test('a blanket, prefix-matched or unexplained allowance suppresses nothing', async (context) => {
	const root = repository('allowance-invalid', {
		'package.json': '{"name":"al","type":"module","exports":"./src/main.ts"}',
		'doctor.config.ts': `import { defineConfig } from '@norbital-ai/doctor';
export default defineConfig({ packs: ['norbital'] });
`,
		'src/main.ts': `export const speak = (): void => {
	// repository-health:allow LOG1
	console.log('no reason given');
	// repository-health:allow LOG -- a token prefix is a different rule, or no rule at all
	console.log('prefix only');
	// repository-health:allow
	console.log('blanket');
	// repository-health:allow LOG1 -- a blank line ends the block, so this is about something else

	console.log('not adjacent');
};
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const result = await audit({ root });
	assert.equal(rules(result.findings, 'LOG1'), 4);
});

test('an allowance on the reported line itself counts', async (context) => {
	const root = repository('allowance-trailing', {
		'package.json': '{"name":"al","type":"module","exports":"./src/main.ts"}',
		'doctor.config.ts': `import { defineConfig } from '@norbital-ai/doctor';
export default defineConfig({ packs: ['norbital'] });
`,
		'src/main.ts': `export const speak = (): void => {
	console.log('report'); // repository-health:allow LOG1 -- stdout is this command's output
};
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const result = await audit({ root });
	assert.equal(rules(result.findings, 'LOG1'), 0);
});
