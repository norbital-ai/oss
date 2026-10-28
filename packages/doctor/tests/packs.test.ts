/**
 * Every shipped rule runs against its own examples: a `bad` example reports, a `good` one does not. A rule scoped to
 * components is given a component, and a bare script body a `<script>` block, or it would be judged on an empty file.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { doctor } from '../src/index.ts';

const PACKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs');

type Examples = {
	bad?: string[];
	good?: string[];
	fixture?: Record<string, string>;
	file?: string;
	goodFile?: string;
};
type Doc = { id: string; files?: string[]; examples?: Examples; pack: string; source: string };

const WORKSPACE = ['boundaries', 'layout', 'reactive', 'svelte'];
const REALM = ['boundaries', 'ceremony', 'effect', 'erase', 'graph', 'overlaps', 'structure'];
const docs: Doc[] = [...WORKSPACE, ...REALM.map((pack) => `realm/${pack}`)].flatMap((pack) =>
	readdirSync(join(PACKS, pack))
		.filter((n) => /\.ya?ml$/.test(n))
		.map((n) => ({
			...(parseYaml(readFileSync(join(PACKS, pack, n), 'utf8')) as Omit<Doc, 'source' | 'pack'>),
			pack,
			source: `${pack}/${n}`
		}))
);

/** `doctor` over `files` written into a scratch repository, with `packs`. */
function scan(files: Record<string, string>, packs: string[]) {
	const root = mkdtempSync(join(tmpdir(), 'doctor-examples-'));
	writeFileSync(join(root, '.norbital-doctor-effect-scope.json'), '["**"]');
	try {
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), content);
		}
		return doctor({ root, files: Object.keys(files), packs });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
const component = (doc: Doc) => (doc.files ?? []).some((glob) => glob.includes('.svelte'));
const body = (doc: Doc, example: string) =>
	component(doc) && !/<\w/.test(example) ? `<script lang="ts">\n${example}\n</script>\n` : example;
/** How many times `doc`'s rule reports on one example in a scratch repository of its own. */
function reports(doc: Doc, example: string, at: string | undefined): number {
	const file = at ?? (component(doc) ? 'src/Probe.svelte' : 'src/probe.ts');
	return scan({ ...doc.examples?.fixture, [file]: body(doc, example) }, [doc.pack]).filter(
		(f) => f.rule === doc.id
	).length;
}
/** Whether a doc's examples need a repository of their own: a fixed path, a fixture, or a cross-file pack. */
const alone = (doc: Doc) =>
	doc.pack === 'realm/graph' ||
	doc.examples?.file !== undefined ||
	doc.examples?.goodFile !== undefined ||
	doc.examples?.fixture !== undefined;

it.effect(
	'the workspace and realm packs load, and every rule declares a bad and a good example',
	() =>
		Effect.sync(() => {
			assert.deepEqual(readdirSync(PACKS).sort(), [...WORKSPACE, 'realm'].sort());
			assert.deepEqual(readdirSync(join(PACKS, 'realm')).sort(), REALM);
			assert.deepEqual(
				docs
					.filter((d) => !d.examples?.bad?.length || !d.examples.good?.length)
					.map((d) => d.source),
				[]
			);
		})
);

// Rules judge one file at a time (only `realm/graph` binds across files), so each pack's portable examples share one
// repository and one scan: example `i` is its own file, and a finding counts for the file it names.
for (const pack of [...new Set(docs.map((d) => d.pack))])
	it.effect(`${pack}: every bad example reports, and every good example does not`, () =>
		Effect.sync(() => {
			const failures: string[] = [];
			const shared: Record<string, string> = {};
			const expected: Array<{ doc: Doc; file: string; bad: boolean; ex: string }> = [];
			for (const doc of docs.filter((d) => d.pack === pack)) {
				const examples = [
					...(doc.examples?.bad ?? []).map((ex) => ({ ex, bad: true })),
					...(doc.examples?.good ?? []).map((ex) => ({ ex, bad: false }))
				];
				for (const { ex, bad } of examples) {
					if (alone(doc)) {
						const n = reports(
							doc,
							ex,
							bad ? doc.examples?.file : (doc.examples?.goodFile ?? doc.examples?.file)
						);
						if (bad === (n === 0))
							failures.push(`${doc.source}: ${bad ? 'bad does not report' : 'good reports'} — ${ex.slice(0, 60)}`);
						continue;
					}
					const file = `src/${component(doc) ? 'Probe' : 'probe'}${expected.length}.${component(doc) ? 'svelte' : 'ts'}`;
					shared[file] = body(doc, ex);
					expected.push({ doc, file, bad, ex });
				}
			}
			const found = expected.length === 0 ? [] : scan(shared, [pack]);
			for (const { doc, file, bad, ex } of expected) {
				const n = found.filter((f) => f.rule === doc.id && f.location.split(':')[0] === file).length;
				if (bad === (n === 0))
					failures.push(`${doc.source}: ${bad ? 'bad does not report' : 'good reports'} — ${ex.slice(0, 60)}`);
			}
			assert.deepEqual(failures, []);
		})
	);

it.effect(
	'a reviewed allowance with a reason suppresses its rule on that line; a bare marker does not',
	() =>
		Effect.sync(() => {
			const doc = docs.find((d) => d.id === 'UI5')!;
			const allowed =
				'<!-- repository-health:allow UI5 -- a fixed-height log pane -->\n<div class="overflow-auto"><p>x</p></div>';
			const bare =
				'<!-- repository-health:allow UI5 -->\n<div class="overflow-auto"><p>x</p></div>';
			assert.equal(reports(doc, allowed, undefined), 0);
			assert.equal(reports(doc, bare, undefined), 1);
		})
);

it.effect(
	'the type-aware tier reports a call to a deprecated declaration once, and an allowance with a reason silences it',
	() =>
		Effect.sync(() => {
			const root = mkdtempSync(join(tmpdir(), 'doctor-types-'));
			try {
				writeFileSync(
					join(root, 'a.ts'),
					'/** @deprecated use next */\nexport function old(): number { return 1; }\nexport function next(): number { return 2; }\n'
				);
				writeFileSync(
					join(root, 'b.ts'),
					"import { next, old } from './a.js';\nexport const v = old() + next();\n"
				);
				const run = () =>
					doctor({ root, files: ['a.ts', 'b.ts'], packs: ['realm/types'] }).map((f) =>
						f.location.split(':').slice(0, 2).join(':')
					);
				assert.deepEqual(run(), ['b.ts:2']);
				writeFileSync(
					join(root, 'b.ts'),
					"import { next, old } from './a.js';\n// repository-health:allow LEGACY2 -- kept until the caller moves\nexport const v = old() + next();\n"
				);
				assert.deepEqual(run(), []);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		})
);

it.effect(
	'realm/graph: a module only a test imports is reached, and the test itself is never reported',
	() =>
		Effect.sync(() => {
			const root = mkdtempSync(join(tmpdir(), 'doctor-graph-'));
			try {
				const files: Record<string, string> = {
					'package.json': '{"name":"graph","type":"module","exports":"./src/index.ts"}',
					'src/index.ts': 'export const run = (): number => 1;\n',
					'src/fixture.ts': 'export const fixture = (): number => 2;\n',
					'src/orphan.ts': 'export const orphan = (): number => 3;\n',
					'tests/fixture.test.ts':
						"import { fixture } from '../src/fixture.js';\nexport const checked = fixture();\n"
				};
				for (const [path, content] of Object.entries(files)) {
					mkdirSync(dirname(join(root, path)), { recursive: true });
					writeFileSync(join(root, path), content);
				}
				const found = doctor({ root, packs: ['realm/graph'] })
					.filter((f) => f.rule === 'FILE1')
					.map((f) => f.location.split(':')[0]);
				assert.deepEqual(found, ['src/orphan.ts']);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		})
);
