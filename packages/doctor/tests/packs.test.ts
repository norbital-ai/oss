/**
 * Every shipped rule runs against its own examples: a `bad` example reports, a `good` one does not. A rule scoped to
 * components is given a component, and a bare script body a `<script>` block, or it would be judged on an empty file.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { doctor } from '../build/index.js';

const PACKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs');

type Examples = { bad?: string[]; good?: string[]; fixture?: Record<string, string>; file?: string; goodFile?: string };
type Doc = { id: string; files?: string[]; examples?: Examples; pack: string; source: string };

const WORKSPACE = ['boundaries', 'layout', 'reactive', 'svelte'];
const REALM = ['boundaries', 'ceremony', 'effect', 'graph', 'overlaps', 'structure'];
const docs: Doc[] = [...WORKSPACE, ...REALM.map((pack) => `realm/${pack}`)].flatMap((pack) =>
	readdirSync(join(PACKS, pack)).filter((n) => /\.ya?ml$/.test(n)).map((n) =>
		({ ...(parseYaml(readFileSync(join(PACKS, pack, n), 'utf8')) as Omit<Doc, 'source' | 'pack'>), pack, source: `${pack}/${n}` })));

/** How many times `doc`'s rule reports on one example written into a scratch repository. */
function reports(doc: Doc, example: string, at: string | undefined): number {
	const component = (doc.files ?? []).some((glob) => glob.includes('.svelte'));
	const file = at ?? (component ? 'src/Probe.svelte' : 'src/probe.ts');
	const body = component && !/<\w/.test(example) ? `<script lang="ts">\n${example}\n</script>\n` : example;
	const root = mkdtempSync(join(tmpdir(), 'doctor-examples-'));
	try {
		const files: Record<string, string> = { ...doc.examples?.fixture, [file]: body };
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		}
		return doctor({ root, files: Object.keys(files), packs: [doc.pack] }).filter((f) => f.rule === doc.id).length;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('the workspace and realm packs load, and every rule declares a bad and a good example', () => {
	assert.deepEqual(readdirSync(PACKS).sort(), [...WORKSPACE, 'realm'].sort());
	assert.deepEqual(readdirSync(join(PACKS, 'realm')).sort(), REALM);
	assert.deepEqual(docs.filter((d) => !d.examples?.bad?.length || !d.examples.good?.length).map((d) => d.source), []);
});

test('every bad example reports, and every good example does not', () => {
	const failures: string[] = [];
	for (const doc of docs) {
		for (const ex of doc.examples?.bad ?? []) if (reports(doc, ex, doc.examples?.file) === 0) failures.push(`${doc.source}: bad does not report — ${ex.slice(0, 60)}`);
		for (const ex of doc.examples?.good ?? []) if (reports(doc, ex, doc.examples?.goodFile ?? doc.examples?.file) > 0) failures.push(`${doc.source}: good reports — ${ex.slice(0, 60)}`);
	}
	assert.deepEqual(failures, []);
});

test('a reviewed allowance with a reason suppresses its rule on that line; a bare marker does not', () => {
	const doc = docs.find((d) => d.id === 'UI5')!;
	const allowed = '<!-- repository-health:allow UI5 -- a fixed-height log pane -->\n<div class="overflow-auto"><p>x</p></div>';
	const bare = '<!-- repository-health:allow UI5 -->\n<div class="overflow-auto"><p>x</p></div>';
	assert.equal(reports(doc, allowed, undefined), 0);
	assert.equal(reports(doc, bare, undefined), 1);
});

test('the type-aware tier reports a call to a deprecated declaration once, and an allowance with a reason silences it', () => {
	const root = mkdtempSync(join(tmpdir(), 'doctor-types-'));
	try {
		writeFileSync(join(root, 'a.ts'), '/** @deprecated use next */\nexport function old(): number { return 1; }\nexport function next(): number { return 2; }\n');
		writeFileSync(join(root, 'b.ts'), "import { next, old } from './a.js';\nexport const v = old() + next();\n");
		const run = () => doctor({ root, files: ['a.ts', 'b.ts'], packs: ['realm/types'] }).map((f) => f.location.split(':').slice(0, 2).join(':'));
		assert.deepEqual(run(), ['b.ts:2']);
		writeFileSync(join(root, 'b.ts'), "import { next, old } from './a.js';\n// repository-health:allow LEGACY2 -- kept until the caller moves\nexport const v = old() + next();\n");
		assert.deepEqual(run(), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('realm/graph: a module only a test imports is reached, and the test itself is never reported', () => {
	const root = mkdtempSync(join(tmpdir(), 'doctor-graph-'));
	try {
		const files: Record<string, string> = {
			'package.json': '{"name":"graph","type":"module","exports":"./src/index.ts"}',
			'src/index.ts': 'export const run = (): number => 1;\n',
			'src/fixture.ts': 'export const fixture = (): number => 2;\n',
			'src/orphan.ts': 'export const orphan = (): number => 3;\n',
			'tests/fixture.test.ts': "import { fixture } from '../src/fixture.js';\nexport const checked = fixture();\n"
		};
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		}
		const found = doctor({ root, packs: ['realm/graph'] }).filter((f) => f.rule === 'FILE1').map((f) => f.location.split(':')[0]);
		assert.deepEqual(found, ['src/orphan.ts']);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
