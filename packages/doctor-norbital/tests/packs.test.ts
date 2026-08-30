/**
 * Behavioral tests for the Norbital packs on real repositories: reactive ownership in .ts and
 * .svelte, the live-transport boundary, and the capability manifest that replaced QRY1.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { runRules } from "@norbital-ai/doctor";

function repository(name: string, files: Readonly<Record<string, string>>): string {
	const root = mkdtempSync(join(tmpdir(), `probe-${name}-`));
	for (const [file, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, file)), { recursive: true });
		writeFileSync(join(root, file), contents);
	}
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["add", "-A"], { cwd: root });
	return root;
}

import { capabilityPack, platformRules, reactivePack } from "../build/index.js";

test('reactive rules fire identically in .ts and .svelte, with correct line numbers', async (context) => {
	// Same statements at the same scope in both: a top-level memo, and a timer inside an effect that
	// drives refresh. The component carries extra leading lines so a shared line number proves nothing.
	const statements = `const refreshedHistory = new Set<string>();
$effect(() => {
	const active = queries.filter((q) => q.current !== undefined);
	const timer = setInterval(() => {
		for (const q of active) void q.refresh();
	}, 1000);
	void timer;
});
void refreshedHistory;
`;
	const root = repository('parity', {
		'package.json': '{"name":"parity","type":"module"}',
		'src/module.ts': `declare const queries: Array<{ current?: unknown; refresh(): void }>;\ndeclare function $effect(run: () => void): void;\n${statements}`,
		'src/view.svelte': `<script lang="ts">\n\tconst queries: Array<{ current?: unknown; refresh(): void }> = [];\n${statements}</script>\n<p>x</p>\n`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const { reactivePack } = await import('../build/index.js');
	const findings = runRules({ root, rules: reactivePack.rules });

	const idsFor = (file: string) =>
		findings
			.filter((finding) => finding.location.startsWith(file))
			.map((finding) => finding.rule)
			.sort();

	// REACT4 is component-scoped by design; the rest must be identical across both file kinds.
	const shared = ['REACT1', 'REACT2', 'REACT3'];
	assert.deepEqual(idsFor('src/module.ts'), shared, 'module');
	assert.deepEqual(idsFor('src/view.svelte'), shared, 'component');

	// A component's findings must point at real lines of the .svelte file, not at script offsets.
	const source = readFileSync(join(root, 'src/view.svelte'), 'utf8').split('\n');
	for (const finding of findings.filter((f) => f.location.startsWith('src/view.svelte'))) {
		const line = Number(finding.location.split(':')[1]);
		assert.ok(source[line - 1] !== undefined, `line ${line} is past the end of the file`);
		assert.match(source[line - 1] ?? '', /setInterval|refresh|new Set/, `line ${line}`);
	}
});

test('the live transport rule reserves SSE for the canonical client sync driver', async (context) => {
	const root = repository('live-transport', {
		'package.json': '{"name":"live-transport","type":"module"}',
		'packages/bolt/src/client/sync/sse-driver.ts':
			"export const source = new EventSource('/events');\nexport const contentType = 'text/event-stream';\nexport const protocol = 'sse';\n",
		'packages/bolt/src/client/other.ts':
			"export const source = new EventSource('/events');\n",
		'src/api/bolt/sync/stream/+server.ts':
			"export const contentType = 'text/event-stream';\nexport const protocol = 'sse';\n",
		'src/browser-events.ts':
			"export const source = new EventSource('/events');\nexport const contentType = 'text/event-stream';\n"
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const { platformRules } = await import('../build/index.js');
	const live = platformRules.filter((rule) => rule.id === 'LIVE2');
	const findings = runRules({ root, rules: live });

	assert.ok(findings.some((finding) => finding.location.startsWith('src/browser-events.ts:')));
	assert.ok(
		findings.some((finding) =>
			finding.location.startsWith('packages/bolt/src/client/other.ts:')
		)
	);
	assert.ok(
		findings.some((finding) => finding.location.startsWith('src/api/bolt/sync/stream/+server.ts:'))
	);
	assert.ok(
		!findings.some((finding) =>
			finding.location.startsWith('packages/bolt/src/client/sync/sse-driver.ts:')
		)
	);
});

test('the capability manifest reports the case QRY1 missed, and survives renaming', async (context) => {
	const { capabilityPack } = await import('../build/index.js');
	const root = repository('capability', {
		'package.json': '{"name":"capability","type":"module"}',
		// The defect the legacy rule reported clean: a timer driving refresh, a scope-level memo,
		// and no client call anywhere.
		'src/original.svelte': `<script lang="ts">
	const refreshedHistory = new Set<string>();
	$effect(() => {
		const timer = setInterval(() => {
			for (const { query } of statusQueries) void query.refresh();
		}, 1_000);
		return () => clearInterval(timer);
	});
</script>
`,
		// Every identifier renamed. The mechanisms are untouched, so the verdict must not move.
		'src/renamed.svelte': `<script lang="ts">
	const alreadyDone = new Set<string>();
	$effect(() => {
		const handle = setInterval(() => {
			for (const { thing } of pending) void thing.refresh();
		}, 1_000);
		return () => clearInterval(handle);
	});
</script>
`,
		// The same mechanisms, but the scope calls the owner: exonerated.
		'src/correct.svelte': `<script lang="ts">
	const rows = client.db.employees.findMany({});
	const seen = new Set<string>();
	$effect(() => {
		const timer = setInterval(() => void rows.refresh(), 1_000);
		return () => clearInterval(timer);
	});
	void seen;
</script>
`
	});
	context.after(() => rmSync(root, { recursive: true, force: true }));

	const findings = runRules({ root, rules: capabilityPack().rules });
	const files = new Set(findings.map((finding) => finding.location.split(':')[0]));

	assert.ok(files.has('src/original.svelte'), 'the case QRY1 missed must be reported');
	assert.ok(
		files.has('src/renamed.svelte'),
		'renaming every identifier must not change the verdict'
	);
	assert.ok(!files.has('src/correct.svelte'), 'calling the owner exonerates the scope');

	// The evidence names the mechanisms and the absence, not a variable name.
	const original = findings.find((f) => f.location.startsWith('src/original.svelte'));
	assert.match(original?.location ?? '', /signals=\d+\/\d+/);
	assert.match(original?.location ?? '', /owner=absent/);
});

