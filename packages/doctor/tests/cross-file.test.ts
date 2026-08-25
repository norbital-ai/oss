/**
 * The whole-repository pass, and who counts as a consumer.
 *
 * A default scan reports on production files only. That is a statement about where findings may
 * land, not about what the graph is allowed to see — and conflating the two made every export whose
 * only callers are tests read as dead code.
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

test('a test file consumes a production export without being reported against', async (context) => {
	const root = repository('cross-file-consumers', {
		'package.json': '{"name":"cf","type":"module","exports":"./src/index.ts"}',
		'src/helper.ts': `export const used = (): number => 1;
export const testOnly = (): number => 2;
export const orphan = (): number => 3;
`,
		'src/index.ts': `import { used } from './helper.js';

export const run = (): number => used();
`,
		'tests/helper.test.ts': `import { testOnly } from '../src/helper.js';

export const check = (): number => testOnly();
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const result = await audit({ root, semantic: { disabled: true } });
	const dead = result.findings
		.filter((finding) => finding.rule === 'EXP1')
		.map((finding) => finding.location);

	// `orphan` is the only export nothing reaches. `testOnly` has a consumer that this scan does
	// not report on, which is not the same as having none.
	assert.equal(dead.length, 1);
	assert.match(dead[0] ?? '', /^src\/helper\.ts:3: .*\[export=orphan\]$/);

	// The consumer joined the graph. It must not have joined the report.
	assert.equal(
		result.findings.some((finding) => finding.location.startsWith('tests/')),
		false
	);
});

test('a production file reached only by a test is not unreachable', async (context) => {
	const root = repository('cross-file-reach', {
		'package.json': '{"name":"cf","type":"module","exports":"./src/index.ts"}',
		'src/index.ts': 'export const run = (): number => 1;\n',
		// Nothing in the package entry graph imports this. Its test does, and a test runner loading
		// a file is as real an execution surface as a package export.
		'src/fixture-support.ts': 'export const support = (): number => 2;\n',
		'tests/support.test.ts': `import { support } from '../src/fixture-support.js';

export const check = (): number => support();
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const result = await audit({ root, semantic: { disabled: true } });
	assert.equal(
		result.findings.some((finding) => finding.rule === 'FILE1'),
		false
	);
});

test('a duplicate body is debt only where the two copies could share an owner', async (context) => {
	const shared = `export function summarise(rows: ReadonlyArray<{ amount: number; kind: string }>): string {
	let total = 0;
	const kinds = new Set<string>();
	for (const row of rows) {
		total += row.amount;
		kinds.add(row.kind);
	}
	return \`\${total} across \${kinds.size} kinds\`;
}
`;
	const root = repository('cross-file-duplicates', {
		'package.json': '{"name":"realm","type":"module","workspaces":["a","b"]}',
		// Two independently published packages. `D1` prescribes "extract one owner and call it from
		// both", and nothing here can be that owner: neither package depends on the other, and in
		// this realm each template directory ships as its own artifact.
		'a/package.json': '{"name":"a","type":"module","exports":"./src/index.ts"}',
		'a/src/index.ts': shared,
		'b/package.json': '{"name":"b","type":"module","exports":"./src/index.ts"}',
		'b/src/index.ts': shared
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const across = await audit({ root, semantic: { disabled: true } });
	assert.equal(
		across.findings.some((finding) => finding.rule === 'D1'),
		false
	);
});

test('a duplicate body inside one package is still reported', async (context) => {
	const shared = `export function summarise(rows: ReadonlyArray<{ amount: number; kind: string }>): string {
	let total = 0;
	const kinds = new Set<string>();
	for (const row of rows) {
		total += row.amount;
		kinds.add(row.kind);
	}
	return \`\${total} across \${kinds.size} kinds\`;
}
`;
	const root = repository('cross-file-duplicates-same', {
		'package.json': '{"name":"a","type":"module","exports":"./src/index.ts"}',
		'src/index.ts': `import './other.js';\n${shared}`,
		'src/other.ts': shared
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const within = await audit({ root, semantic: { disabled: true } });
	assert.equal(
		within.findings.some((finding) => finding.rule === 'D1'),
		true
	);
});
