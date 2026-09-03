/**
 * The layout rules, which describe a component's markup.
 *
 * They had no fixtures at all — `port.test.ts` exempts them for "the svelte suite", and there was
 * no svelte suite. The gap hid a real defect: every one of them matched against the whole file,
 * `<script>` included, so `UI17` reported a query filter `{ eq: record.id }` as a uuid shown to an
 * operator. Two independent slices of the realm hit it before it was found.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runRules } from '@norbital-ai/doctor';
import { svelteRules } from '../build/index.js';

function component(name: string, source: string): string {
	const root = mkdtempSync(join(tmpdir(), `probe-layout-${name}-`));
	const file = 'src/Thing.svelte';
	mkdirSync(dirname(join(root, file)), { recursive: true });
	writeFileSync(join(root, file), source);
	return root;
}

function rulesFor(root: string): ReadonlyArray<string> {
	// The whole svelte pack, not one rule: dispatch and the `files: COMPONENT` scope are part of
	// what these cases prove.
	return runRules({ root, rules: [...svelteRules], files: ['src/Thing.svelte'] }).map(
		(finding) => finding.rule
	);
}

test('UI17 reads the markup and ignores an id that never leaves the script', (context) => {
	const root = component(
		'ui17-script',
		`<script lang="ts">
	const record = { id: 'x' };
	const rows = query({ where: { job_id: { eq: record.id } } });
</script>

<p>{record.name}</p>
`
	);
	context.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(rulesFor(root).includes('UI17'), false);
});

test('UI17 still reports a system id rendered to a person', (context) => {
	const root = component(
		'ui17-markup',
		`<script lang="ts">
	const record = { id: 'x' };
</script>

<p>{record.id}</p>
`
	);
	context.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(rulesFor(root).includes('UI17'), true);
});

test('UI17 rejects framework fields declared in collection surface composition', (context) => {
	const root = component(
		'ui17-system-composition',
		`<CollectionTable>
	{#snippet columns({ Column })}
		<Column
			name="id"
		/>
	{/snippet}
</CollectionTable>
`
	);
	context.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(rulesFor(root).includes('UI17'), true);
});

test('UI17 rejects an explicitly hidden framework field in a form', (context) => {
	const root = component(
		'ui17-hidden-system-field',
		`<CollectionForm>
	{#snippet children({ Field })}
		<Field name="id" hidden />
	{/snippet}
</CollectionForm>
`
	);
	context.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(rulesFor(root).includes('UI17'), true);
});

test('UI17 rejects a framework field supplied as a static Svelte expression', (context) => {
	const root = component(
		'ui17-expression-system-field',
		`<CollectionTable>
	{#snippet columns({ Column })}
		<Column name={'id'} />
	{/snippet}
</CollectionTable>
`
	);
	context.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(rulesFor(root).includes('UI17'), true);
});

test('UI6 reports a raw flex container in markup', (context) => {
	const root = component(
		'ui6',
		`<div class="flex gap-2">
	<span>one</span>
	<span>two</span>
</div>
`
	);
	context.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(rulesFor(root).includes('UI6'), true);
});

test('UI6 leaves a layout primitive alone', (context) => {
	const root = component(
		'ui6-clean',
		`<Stack gap="sm">
	<span>one</span>
	<span>two</span>
</Stack>
`
	);
	context.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(rulesFor(root).includes('UI6'), false);
});

test('UI17 ignores an id used as a query argument or a list key in markup', (context) => {
	const root = component(
		'ui17-arguments',
		`<script lang="ts">
	const record = { id: 'x' };
	const rows: Array<{ id: string; name: string }> = [];
</script>

<CollectionTable query={{ where: { job_id: { eq: record.id } } }} />
{#each rows as row (row.id)}
	<p>{row.name}</p>
{/each}
`
	);
	context.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(rulesFor(root).includes('UI17'), false);
});

test('a layout rule does not read prose out of an HTML comment', (context) => {
	const root = component(
		'ui5-comment',
		`<!-- This used to be a Stack whose middle child was a div.overflow-x-auto. -->
<Scroll>
	<p>rows</p>
</Scroll>
`
	);
	context.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(rulesFor(root).includes('UI5'), false);
});

test('UI17 ignores a template-literal hole and an attribute value', (context) => {
	const root = component(
		'ui17-holes',
		`<script lang="ts">
	const section = { id: 'collections' };
	const view = { organization: { id: 'org' } };
</script>

<OrganizationSettings tenantId={view.organization.id} />
<button onclick={() => onselect?.(\`\${section.id}:name\`)}>pick</button>
`
	);
	context.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(rulesFor(root).includes('UI17'), false);
});

test('V1 reports an effect that only recomputes a value', (context) => {
	const root = component(
		'v1-pure',
		`<script lang="ts">
	let a = $state(1);
	let b = $state(2);
	let total = $state(0);
	$effect(() => {
		total = a + b;
	});
</script>

<p>{total}</p>
`
	);
	context.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(rulesFor(root).includes('V1'), true);
});

test('V1 leaves an effect that returns a teardown or performs a call', (context) => {
	const root = component(
		'v1-external',
		`<script lang="ts">
	let published = $state(false);
	let current = $state(0);
	// A teardown is not something \`$derived\` can express.
	$effect(() => {
		published = true;
		return () => {
			published = false;
		};
	});
	// Neither is pushing a value across a component boundary.
	$effect(() => {
		const next = current;
		handle?.update(next);
	});
</script>

<p>{published}</p>
`
	);
	context.after(() => rmSync(root, { recursive: true, force: true }));
	assert.equal(rulesFor(root).includes('V1'), false);
});

test('the nine-violation component reports nine layout findings', (context) => {
	const root = component(
		'nine-violation',
		`<script lang="ts">
	const shell = 'flex';
	const open = true;
</script>
<div class="flex items-center justify-between"></div>
<div class="absolute inset-0 z-50"></div>
<div class="sticky top-0 z-10"></div>
<div class="h-screen w-screen"></div>
<div class="h-[calc(100dvh-4rem)]"></div>
<div class="overflow-hidden"></div>
<div style="display:flex; position:absolute"></div>
<div class={shell}></div>
<div class:grid={open}></div>
<style>.panel { display:grid; position:fixed }</style>
`
	);
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const findings = runRules({ root, rules: [...svelteRules], files: ['src/Thing.svelte'] });
	assert.ok(
		findings.length >= 9,
		`expected at least nine findings, got ${findings.length}: ${findings.map((row) => row.rule).join(',')}`
	);
});
