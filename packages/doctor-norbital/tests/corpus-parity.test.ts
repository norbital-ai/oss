/**
 * D8 corpus parity for the Norbital visitors of the original 53.
 *
 * A rule is proven only when at least three discriminating observations pass.
 * Realm 0-vs-0 is not an observation.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runRules, type Rule } from '@norbital-ai/doctor';
import { capabilityPack, platformRules, svelteRules } from '../build/index.js';

const { parse: parseYaml } = createRequire(
	join(dirname(fileURLToPath(import.meta.url)), '../../doctor/package.json')
)('yaml') as { parse: (text: string) => unknown };

/** The 26 Norbital members of the original 53 imperative visitors. */
const NORBITAL_53 = [
	'CAP_MUTATION',
	'CAP_QUERY',
	'COMPAT1',
	'DDL1',
	'E2',
	'LEGACY1',
	'LIVE1',
	'LIVE2',
	'ORM1',
	'QRY2',
	'QRY3',
	'QRY4',
	'ROOT1',
	'SQL1',
	'TRANS1',
	'TRANS2',
	'UI5',
	'UI6',
	'UI7',
	'UI8',
	'UI12',
	'UI15',
	'UI17',
	'UI18',
	'V1',
	'V15'
] as const;

/** Leftover after the first sweep — these are the ids this pass can move. */
const LEFTOVER = [
	'CAP_MUTATION',
	'CAP_QUERY',
	'COMPAT1',
	'DDL1',
	'LEGACY1',
	'LIVE1',
	'ORM1',
	'QRY2',
	'QRY4',
	'SQL1',
	'TRANS1',
	'UI5',
	'UI6',
	'UI7',
	'UI8',
	'UI12',
	'UI15',
	'UI17',
	'UI18',
	'V1',
	'V15'
] as const;

const FLOOR = 3;
const PACKS = join(dirname(fileURLToPath(import.meta.url)), '../packs');

type Expectation = 'fire' | 'quiet';

type Observation = Readonly<{
	id: string;
	source: string;
	expect: Expectation;
	file?: string;
	fixture?: Readonly<Record<string, string>>;
}>;

type Documented = Readonly<{
	id: string;
	bad: ReadonlyArray<string>;
	good: ReadonlyArray<string>;
	file: string | undefined;
	fixture: Readonly<Record<string, string>>;
}>;

const ALL_RULES: ReadonlyArray<Rule> = [
	...platformRules,
	...svelteRules,
	...capabilityPack().rules
];

function documented(): ReadonlyMap<string, Documented> {
	const rows = new Map<string, Documented>();
	for (const pack of ['platform', 'svelte', 'capability']) {
		const directory = join(PACKS, pack);
		for (const name of readdirSync(directory).filter((entry) => /\.ya?ml$/.test(entry))) {
			const document = parseYaml(readFileSync(join(directory, name), 'utf8')) as {
				id?: string;
				examples?: {
					bad?: ReadonlyArray<string>;
					good?: ReadonlyArray<string>;
					fixture?: Readonly<Record<string, string>>;
					file?: string;
				};
			};
			if (document.id === undefined) continue;
			rows.set(document.id, {
				id: document.id,
				bad: document.examples?.bad ?? [],
				good: document.examples?.good ?? [],
				file: document.examples?.file,
				fixture: document.examples?.fixture ?? {}
			});
		}
	}
	return rows;
}

const SQL = "export const q = sql`SELECT id FROM things WHERE tenant_id = ${id}`;";

/** Extra cases already asserted in packs.test.ts / svelte-layout.test.ts / port.test.ts. */
const EXTRAS: ReadonlyArray<Observation> = [
	{
		id: 'LIVE1',
		file: 'src/probe.ts',
		source: 'export const pollStatus = () => status();',
		expect: 'fire'
	},
	{
		id: 'LIVE1',
		file: 'src/probe.ts',
		source: 'export async function watch() { while (true) { await sleep(1000); await status(); } }',
		expect: 'fire'
	},
	{
		id: 'LIVE1',
		file: 'src/probe.ts',
		source:
			'export const rows = client.db.things.findMany({});\nexport const clock = setInterval(() => { currentTime = new Date(); }, 60_000);\nexport const watchdogPollMillis = 250;',
		expect: 'quiet'
	},
	{
		id: 'LIVE1',
		file: 'src/probe.ts',
		source: 'export function transform(rows) { for (const row of rows) emit(row); }',
		expect: 'quiet'
	},
	{ id: 'SQL1', file: 'src/app.ts', source: SQL, expect: 'fire' },
	{
		id: 'SQL1',
		file: 'packages/bolt/src/runtime/collections/read/search.ts',
		source: SQL,
		expect: 'quiet'
	},
	{
		id: 'SQL1',
		file: 'packages/bolt/src/runtime/access/predicate.ts',
		source: SQL,
		expect: 'quiet'
	},
	{
		id: 'SQL1',
		file: 'packages/bolt/src/runtime/identity/identity.ts',
		source: SQL,
		expect: 'quiet'
	},
	{
		id: 'LIVE2',
		file: 'src/browser-events.ts',
		source:
			"export const source = new EventSource('/events');\nexport const contentType = 'text/event-stream';\n",
		expect: 'fire'
	},
	{
		id: 'LIVE2',
		file: 'packages/bolt/src/client/other.ts',
		source: "export const source = new EventSource('/events');\n",
		expect: 'fire'
	},
	{
		id: 'LIVE2',
		file: 'src/api/bolt/sync/stream/+server.ts',
		source:
			"export const contentType = 'text/event-stream';\nexport const protocol = 'sse';\n",
		expect: 'quiet'
	},
	{
		id: 'LIVE2',
		file: 'packages/bolt/src/client/sync/sse-driver.ts',
		source:
			"export const source = new EventSource('/events');\nexport const contentType = 'text/event-stream';\n",
		expect: 'quiet'
	},
	{
		id: 'LIVE2',
		file: 'src/detect-stream.ts',
		source:
			"export const isSse = (contentType: string) => contentType === 'text/event-stream';\n",
		expect: 'quiet'
	},
	{
		id: 'CAP_QUERY',
		file: 'src/original.svelte',
		source: `<script lang="ts">
	const refreshedHistory = new Set<string>();
	$effect(() => {
		const timer = setInterval(() => {
			for (const { query } of statusQueries) void query.refresh();
		}, 1_000);
		return () => clearInterval(timer);
	});
</script>
`,
		expect: 'fire'
	},
	{
		id: 'CAP_QUERY',
		file: 'src/renamed.svelte',
		source: `<script lang="ts">
	const alreadyDone = new Set<string>();
	$effect(() => {
		const handle = setInterval(() => {
			for (const { thing } of pending) void thing.refresh();
		}, 1_000);
		return () => clearInterval(handle);
	});
</script>
`,
		expect: 'fire'
	},
	{
		id: 'CAP_QUERY',
		file: 'src/correct.svelte',
		source: `<script lang="ts">
	const rows = client.db.employees.findMany({});
	const seen = new Set<string>();
	$effect(() => {
		const timer = setInterval(() => void rows.refresh(), 1_000);
		return () => clearInterval(timer);
	});
	void seen;
</script>
`,
		expect: 'quiet'
	},
	{
		id: 'UI17',
		file: 'src/Thing.svelte',
		source: `<script lang="ts">
	const record = { id: 'x' };
	const rows = query({ where: { job_id: { eq: record.id } } });
</script>

<p>{record.name}</p>
`,
		expect: 'quiet'
	},
	{
		id: 'UI17',
		file: 'src/Thing.svelte',
		source: `<script lang="ts">
	const record = { id: 'x' };
</script>

<p>{record.id}</p>
`,
		expect: 'fire'
	},
	{
		id: 'UI17',
		file: 'src/Thing.svelte',
		source: `<CollectionTable>
	{#snippet columns({ Column })}
		<Column name="id" />
	{/snippet}
</CollectionTable>
`,
		expect: 'fire'
	},
	{
		id: 'UI17',
		file: 'src/Thing.svelte',
		source: `<CollectionForm>
	{#snippet children({ Field })}
		<Field name="id" hidden />
	{/snippet}
</CollectionForm>
`,
		expect: 'fire'
	},
	{
		id: 'UI17',
		file: 'src/Thing.svelte',
		source: `<CollectionTable>
	{#snippet columns({ Column })}
		<Column name={'id'} />
	{/snippet}
</CollectionTable>
`,
		expect: 'fire'
	},
	{
		id: 'UI17',
		file: 'src/Thing.svelte',
		source: `<script lang="ts">
	const record = { id: 'x' };
	const rows: Array<{ id: string; name: string }> = [];
</script>

<CollectionTable query={{ where: { job_id: { eq: record.id } } }} />
{#each rows as row (row.id)}
	<p>{row.name}</p>
{/each}
`,
		expect: 'quiet'
	},
	{
		id: 'UI17',
		file: 'src/Thing.svelte',
		source: `<script lang="ts">
	const section = { id: 'collections' };
	const view = { organization: { id: 'org' } };
</script>

<OrganizationSettings tenantId={view.organization.id} />
<button onclick={() => onselect?.(\`\${section.id}:name\`)}>pick</button>
`,
		expect: 'quiet'
	},
	{
		id: 'UI6',
		file: 'src/Thing.svelte',
		source: `<div class="flex gap-2">
	<span>one</span>
	<span>two</span>
</div>
`,
		expect: 'fire'
	},
	{
		id: 'UI6',
		file: 'src/Thing.svelte',
		source: `<Stack gap="sm">
	<span>one</span>
	<span>two</span>
</Stack>
`,
		expect: 'quiet'
	},
	{
		id: 'UI5',
		file: 'src/Thing.svelte',
		source: `<!-- This used to be a Stack whose middle child was a div.overflow-x-auto. -->
<Scroll>
	<p>rows</p>
</Scroll>
`,
		expect: 'quiet'
	},
	{
		id: 'V1',
		file: 'src/Thing.svelte',
		source: `<script lang="ts">
	let a = $state(1);
	let b = $state(2);
	let total = $state(0);
	$effect(() => {
		total = a + b;
	});
</script>

<p>{total}</p>
`,
		expect: 'fire'
	},
	{
		id: 'V1',
		file: 'src/Thing.svelte',
		source: `<script lang="ts">
	let published = $state(false);
	let current = $state(0);
	$effect(() => {
		published = true;
		return () => {
			published = false;
		};
	});
	$effect(() => {
		const next = current;
		handle?.update(next);
	});
</script>

<p>{published}</p>
`,
		expect: 'quiet'
	},
	{
		id: 'CAP_MUTATION',
		file: 'src/probe.ts',
		source: `async function save() {
	let submitting = $state(false);
	let failure = $state(undefined);
	toast.success('saved');
	void submitting;
	void failure;
}
`,
		expect: 'fire'
	},
	{
		id: 'CAP_MUTATION',
		file: 'src/probe.ts',
		source: `async function save() {
	let pending = $state(false);
	let lastError = $state(undefined);
	try {
		await send();
	} catch (cause) {
		lastError = cause;
	}
	void pending;
}
`,
		expect: 'fire'
	},
	{
		id: 'CAP_MUTATION',
		file: 'src/probe.ts',
		source: `async function save() {
	let inFlight = $state(false);
	let error = $state(undefined);
	toast.error('failed');
	void inFlight;
	void error;
}
`,
		expect: 'fire'
	},
	{
		id: 'CAP_MUTATION',
		file: 'src/probe.ts',
		source: `async function save() {
	let saving = $state(false);
	let error = $state(undefined);
	try {
		await send();
	} catch (cause) {
		error = cause;
	}
	const result = client.db.things.create(input);
	void saving;
	void result;
}
`,
		expect: 'quiet'
	},
	{
		id: 'CAP_MUTATION',
		file: 'src/probe.ts',
		source: `async function save() {
	let saving = $state(false);
	let error = $state(undefined);
	void saving;
	void error;
}
`,
		expect: 'quiet'
	},
	{
		id: 'CAP_MUTATION',
		file: 'src/probe.ts',
		source: `async function save() {
	let saving = $state(false);
	let error = $state(undefined);
	try {
		await send();
	} catch (cause) {
		error = cause;
	}
	mutation.mutate(input);
	void saving;
}
`,
		expect: 'quiet'
	},
	{
		id: 'COMPAT1',
		file: 'src/probe.ts',
		source: '// compatibility shim for the old name\nexport const oldName = newName;',
		expect: 'fire'
	},
	{
		id: 'COMPAT1',
		file: 'src/probe.ts',
		source: '// compat alias for the old name\nexport const oldName = newName;',
		expect: 'fire'
	},
	{
		id: 'COMPAT1',
		file: 'src/probe.ts',
		source: '// backwards-compatible export\nexport function oldName() { return newName(); }',
		expect: 'fire'
	},
	{
		id: 'COMPAT1',
		file: 'src/probe.ts',
		source: '// legacy helper for the old name\nexport const oldName = newName;',
		expect: 'quiet'
	},
	{
		id: 'TRANS1',
		file: 'src/probe.ts',
		source: '// FIXME: delete this after cutover\nexport const bridge = 1;',
		expect: 'fire'
	},
	{
		id: 'TRANS1',
		file: 'src/probe.ts',
		source: '// HACK: temporary until the migrator ships\nexport const bridge = 1;',
		expect: 'fire'
	},
	{
		id: 'TRANS1',
		file: 'src/probe.ts',
		source: '// TODO: drop once the cutover ships\nexport const bridge = 1;',
		expect: 'fire'
	},
	{
		id: 'TRANS1',
		file: 'src/probe.ts',
		source: '// TODO: document the importer\nexport const bridge = 1;',
		expect: 'quiet'
	},
	{
		id: 'TRANS1',
		file: 'src/probe.ts',
		source: '// FIXME: the importer needs it\nexport const bridge = 1;',
		expect: 'quiet'
	},
	{
		id: 'LEGACY1',
		file: 'src/probe.ts',
		source: '/** @deprecated */\nexport const old = 1;',
		expect: 'fire'
	},
	{
		id: 'LEGACY1',
		file: 'src/probe.ts',
		source: '/** @deprecated */\nexport class Old {}',
		expect: 'fire'
	},
	{
		id: 'LEGACY1',
		file: 'src/probe.ts',
		source: '/** @deprecated */\nexport type Old = string;',
		expect: 'fire'
	},
	{
		id: 'LEGACY1',
		file: 'src/probe.ts',
		source: '/** @deprecated */\nexport interface Old { x: number }',
		expect: 'fire'
	},
	{
		id: 'LEGACY1',
		file: 'src/probe.ts',
		source: '// @deprecated use next\nexport function old() { return 1; }',
		expect: 'quiet'
	},
	{
		id: 'ORM1',
		file: 'src/probe.ts',
		source: "export const t = { name: text('thing_name') };",
		expect: 'fire'
	},
	{
		id: 'ORM1',
		file: 'src/probe.ts',
		source: "export const t = { active: boolean('is_active') };",
		expect: 'fire'
	},
	{
		id: 'ORM1',
		file: 'src/probe.ts',
		source: "export const t = { createdAt: timestamp('created_at') };",
		expect: 'fire'
	},
	{
		id: 'ORM1',
		file: 'src/probe.ts',
		source: 'export const t = { id: integer() };',
		expect: 'quiet'
	},
	{
		id: 'ORM1',
		file: 'src/probe.ts',
		source: "export const t = { id: integer('id') };",
		expect: 'quiet'
	},
	{
		id: 'DDL1',
		file: 'src/probe.ts',
		source: "export const v = pgView('things', {});",
		expect: 'fire'
	},
	{
		id: 'DDL1',
		file: 'src/probe.ts',
		source: "export const i = uniqueIndex('things_name');",
		expect: 'fire'
	},
	{
		id: 'DDL1',
		file: 'src/probe.ts',
		source: 'export const k = foreignKey({});',
		expect: 'fire'
	},
	{
		id: 'DDL1',
		file: 'src/probe.ts',
		source: "export const t = db.pgTable('things', {});",
		expect: 'quiet'
	},
	{
		id: 'DDL1',
		file: 'src/migrations/001.ts',
		source: "export const t = pgTable('things', {});",
		expect: 'quiet'
	},
	{
		id: 'DDL1',
		file: 'src/probe.ts',
		source: "import { index } from 'drizzle-orm';\nexport const i = index('things_name');",
		expect: 'fire'
	},
	{
		id: 'DDL1',
		file: 'src/probe.ts',
		source: "export const i = index('things_name');",
		expect: 'quiet'
	},
	{
		id: 'QRY2',
		file: 'src/probe.ts',
		source: 'export const f = () => { void rows.refresh(); };',
		expect: 'fire'
	},
	{
		id: 'QRY2',
		file: 'src/probe.ts',
		source: 'export const f = () => { void records.refresh(); };',
		expect: 'fire'
	},
	{
		id: 'QRY2',
		file: 'src/probe.ts',
		source: 'export const f = () => { void history.refresh(); };',
		expect: 'fire'
	},
	{
		id: 'QRY2',
		file: 'src/probe.ts',
		source: 'export const f = () => { void query.refetch(); };',
		expect: 'fire'
	},
	{
		id: 'QRY2',
		file: 'src/probe.ts',
		source: 'export const f = () => { void toc.refetch(); };',
		expect: 'fire'
	},
	{
		id: 'QRY2',
		file: 'src/probe.ts',
		source: 'export const f = () => { void toc.refresh(); };',
		expect: 'quiet'
	},
	{
		id: 'QRY2',
		file: 'src/probe.ts',
		source: 'export const f = () => { void client.refresh(); };',
		expect: 'quiet'
	},
	{
		id: 'QRY4',
		file: 'src/probe.ts',
		source: 'export type LiveQuery = { refetch(): void };',
		expect: 'fire'
	},
	{
		id: 'QRY4',
		file: 'src/probe.ts',
		source: 'export class QueryClient { refresh() { return 1; } }',
		expect: 'fire'
	},
	{
		id: 'QRY4',
		file: 'src/probe.ts',
		source: 'export interface RemoteQuery { refetch(): Promise<void> }',
		expect: 'fire'
	},
	{
		id: 'QRY4',
		file: 'src/probe.ts',
		source: 'export interface RemoteService { refresh(): void }',
		expect: 'quiet'
	},
	{
		id: 'QRY4',
		file: 'src/probe.ts',
		source: 'export class DocumentToc { refresh() { return 1; } }',
		expect: 'quiet'
	},
	{
		id: 'UI18',
		file: 'src/ui/probe.ts',
		source: 'export const f = () => transport.execute({});',
		expect: 'fire'
	},
	{
		id: 'UI18',
		file: 'src/ui/probe.ts',
		source: 'export const f = () => connection.send({});',
		expect: 'fire'
	},
	{
		id: 'UI18',
		file: 'src/ui/probe.ts',
		source: 'export const f = () => socket.invoke({});',
		expect: 'fire'
	},
	{
		id: 'UI18',
		file: 'src/probe.ts',
		source: 'export const f = () => transport.command({});',
		expect: 'quiet'
	},
	{
		id: 'UI18',
		file: 'src/Thing.svelte',
		source: 'export const f = () => transport.command({});',
		expect: 'fire'
	},
	{
		id: 'UI7',
		file: 'src/Thing.svelte',
		source: '<div class="space-x-2"><p>a</p></div>',
		expect: 'fire'
	},
	{
		id: 'UI7',
		file: 'src/Thing.svelte',
		source: '<div class="mt-4"><p>a</p></div>',
		expect: 'fire'
	},
	{
		id: 'UI7',
		file: 'src/Thing.svelte',
		source: '<div class="mb-12"><p>a</p></div>',
		expect: 'fire'
	},
	{
		id: 'UI7',
		file: 'src/Thing.svelte',
		source: '<div class="mt-1"><p>a</p></div>',
		expect: 'quiet'
	},
	{
		id: 'UI7',
		file: 'src/Thing.svelte',
		source: '<div class="p-4"><p>a</p></div>',
		expect: 'quiet'
	},
	{
		id: 'UI8',
		file: 'src/Thing.svelte',
		source: '<div class="px-4 py-2 sm:px-6"></div>',
		expect: 'fire'
	},
	{
		id: 'UI8',
		file: 'src/Thing.svelte',
		source: '<div class="mx-4 sm:mx-6"></div>',
		expect: 'fire'
	},
	{
		id: 'UI8',
		file: 'src/Thing.svelte',
		source: '<div class="px-4"></div>',
		expect: 'quiet'
	},
	{
		id: 'UI8',
		file: 'src/Thing.svelte',
		source: '<div class="px-6 sm:px-8"></div>',
		expect: 'quiet'
	},
	{
		id: 'UI12',
		file: 'src/Thing.svelte',
		source: '<div class={`w-[${n}px]`}></div>',
		expect: 'fire'
	},
	{
		id: 'UI12',
		file: 'src/Thing.svelte',
		source: '<span class={`h-[${h}rem]`}></span>',
		expect: 'fire'
	},
	{
		id: 'UI12',
		file: 'src/Thing.svelte',
		source: '<div class="mt-[4px]"></div>',
		expect: 'quiet'
	},
	{
		id: 'UI12',
		file: 'src/Thing.svelte',
		source: '<div class={sizeClass}></div>',
		expect: 'quiet'
	},
	{
		id: 'UI15',
		file: 'src/Thing.svelte',
		source: '<Inline class="w-[12rem]"><p>x</p></Inline>',
		expect: 'fire'
	},
	{
		id: 'UI15',
		file: 'src/Thing.svelte',
		source: '<Grid class="min-h-[8rem]"><p>x</p></Grid>',
		expect: 'fire'
	},
	{
		id: 'UI15',
		file: 'src/Thing.svelte',
		source: '<Cover class="min-w-[20rem]"><p>x</p></Cover>',
		expect: 'fire'
	},
	{
		id: 'UI15',
		file: 'src/Thing.svelte',
		source: '<Stack class="h-16"><p>x</p></Stack>',
		expect: 'quiet'
	},
	{
		id: 'UI15',
		file: 'src/Thing.svelte',
		source: '<div class="h-[4rem]"><p>x</p></div>',
		expect: 'quiet'
	},
	{
		id: 'V15',
		file: 'src/Thing.svelte',
		source: 'const title = item.value;',
		expect: 'fire'
	},
	{
		id: 'V15',
		file: 'src/Thing.svelte',
		source: 'const ready = count.current;',
		expect: 'fire'
	},
	{
		id: 'V15',
		file: 'src/Thing.svelte',
		source: 'const total = count.current * 2;',
		expect: 'fire'
	},
	{
		id: 'V15',
		file: 'src/Thing.svelte',
		source: 'function f() { const label = props.current + suffix; }',
		expect: 'quiet'
	},
	{
		id: 'V15',
		file: 'src/Thing.svelte',
		source: 'const label = suffix;',
		expect: 'quiet'
	},
	{
		id: 'E2',
		file: 'src/probe.ts',
		source: 'const FEATURE_X = false;',
		expect: 'fire'
	},
	{
		id: 'E2',
		file: 'src/probe.ts',
		source: 'let FLAG_BETA = true;',
		expect: 'fire'
	},
	{
		id: 'E2',
		file: 'src/probe.ts',
		source: 'export const USE_NEW_UI = false;',
		expect: 'fire'
	},
	{
		id: 'E2',
		file: 'src/probe.ts',
		source: 'const enable_beta = true;',
		expect: 'quiet'
	},
	{
		id: 'E2',
		file: 'src/probe.ts',
		source: 'export const FEATURE_X = config.flag;',
		expect: 'quiet'
	},
	{
		id: 'QRY3',
		file: 'src/probe.ts',
		source: 'export const row = client.db.things.findFirst({});',
		expect: 'fire'
	},
	{
		id: 'QRY3',
		file: 'src/probe.ts',
		source: 'export const n = client.db.things.count({});',
		expect: 'fire'
	},
	{
		id: 'QRY3',
		file: 'src/probe.ts',
		source: 'export function load() { const rows = client.db.things.findMany({}); return rows; }',
		expect: 'fire'
	},
	{
		id: 'QRY3',
		file: 'src/probe.ts',
		source: 'export const rows = $derived.by(() => client.db.things.findMany({}));',
		expect: 'quiet'
	},
	{
		id: 'QRY3',
		file: 'scripts/seed.ts',
		source: 'export const rows = client.db.things.findMany({});',
		expect: 'quiet'
	},
	{
		id: 'ROOT1',
		file: 'src/probe.ts',
		source: 'export const store = process.env.COLONY_PACKAGE_STORE;',
		expect: 'fire'
	},
	{
		id: 'ROOT1',
		file: 'src/probe.ts',
		source: "export const name = 'COLONY_DATA_DIRECTORY';",
		expect: 'fire'
	},
	{
		id: 'ROOT1',
		file: 'src/probe.ts',
		source: 'export const name = `COLONY_PACKAGE_STORE`;',
		expect: 'fire'
	},
	{
		id: 'ROOT1',
		file: 'scripts/tenant-substrate-root.mjs',
		source: 'export const root = process.env.COLONY_DATA_DIRECTORY;',
		expect: 'quiet'
	},
	{
		id: 'TRANS2',
		file: 'src/probe.ts',
		source: 'export const n = row.name || row.previous;',
		expect: 'fire'
	},
	{
		id: 'TRANS2',
		file: 'src/probe.ts',
		source: 'export const changed = previous === undefined || previous.mode !== file.mode;',
		expect: 'quiet'
	},
	{
		id: 'TRANS2',
		file: 'src/probe.ts',
		source: 'export const n = row.name || row.old_name;',
		expect: 'fire'
	},
	{
		id: 'TRANS2',
		file: 'src/probe.ts',
		source: 'export const n = row.name ?? row.deprecated_label;',
		expect: 'fire'
	},
	{
		id: 'TRANS2',
		file: 'src/probe.ts',
		source: 'export const n = row.name ?? row.v1;',
		expect: 'fire'
	},
	{
		id: 'TRANS2',
		file: 'src/probe.ts',
		source: 'export const n = row.previous ?? row.name;',
		expect: 'quiet'
	},
	{
		id: 'TRANS2',
		file: 'src/probe.ts',
		source: 'export const n = row.name ?? row.v2;',
		expect: 'quiet'
	}
];

function observationsFor(id: string, docs: ReadonlyMap<string, Documented>): ReadonlyArray<Observation> {
	const document = docs.get(id);
	const fromYaml: Array<Observation> = [];
	if (document !== undefined) {
		for (const source of document.bad)
			fromYaml.push({
				id,
				source,
				expect: 'fire',
				file: document.file,
				fixture: document.fixture
			});
		for (const source of document.good)
			fromYaml.push({
				id,
				source,
				expect: 'quiet',
				file: document.file,
				fixture: document.fixture
			});
	}
	return [...fromYaml, ...EXTRAS.filter((row) => row.id === id)];
}

function wrapComponent(rule: Rule, file: string, source: string): string {
	const componentScoped = (rule.files ?? []).some((glob) => glob.includes('.svelte'));
	if (!componentScoped || !file.endsWith('.svelte')) return source;
	if (/<\w/.test(source)) return source;
	return `<script lang="ts">\n${source}\n</script>\n`;
}

function fires(rule: Rule, observation: Observation): boolean {
	const file = observation.file ?? ((rule.files ?? []).some((glob) => glob.includes('.svelte'))
		? 'src/Probe.svelte'
		: 'src/probe.ts');
	const body = wrapComponent(rule, file, observation.source);
	const root = mkdtempSync(join(tmpdir(), 'doctor-norbital-d8-'));
	try {
		const files: Record<string, string> = { ...(observation.fixture ?? {}), [file]: body };
		writeFileSync(join(root, 'package.json'), '{"name":"doctor-norbital-d8","type":"module"}');
		for (const [path, contents] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), contents);
		}
		return runRules({ root, rules: [rule], files: Object.keys(files) }).some(
			(finding) => finding.rule === rule.id
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

type Verdict = Readonly<{
	id: string;
	observations: number;
	failures: ReadonlyArray<string>;
	proven: boolean;
}>;

function meetsFloor(observations: number, failures: number): boolean {
	return observations >= FLOOR && failures === 0;
}

function judge(docs: ReadonlyMap<string, Documented>): ReadonlyArray<Verdict> {
	return NORBITAL_53.map((id) => {
		const rule = ALL_RULES.find((candidate) => candidate.id === id);
		assert.ok(rule !== undefined, `${id} is not in a Norbital pack`);
		const observations = observationsFor(id, docs);
		const failures: Array<string> = [];
		for (const observation of observations) {
			const reported = fires(rule, observation);
			if (observation.expect === 'fire' && !reported)
				failures.push(`${id} did not fire on ${observation.source.replace(/\s+/g, ' ').slice(0, 72)}`);
			if (observation.expect === 'quiet' && reported)
				failures.push(`${id} fired on ${observation.source.replace(/\s+/g, ' ').slice(0, 72)}`);
		}
		return {
			id,
			observations: observations.length,
			failures,
			proven: meetsFloor(observations.length, failures.length)
		};
	});
}

const verdicts = judge(documented());

test('the harness refuses a verdict below three discriminating observations', () => {
	assert.equal(meetsFloor(2, 0), false);
	assert.equal(meetsFloor(FLOOR, 0), true);
	assert.equal(meetsFloor(FLOOR, 1), false);
	for (const verdict of verdicts)
		assert.equal(
			verdict.proven,
			meetsFloor(verdict.observations, verdict.failures.length),
			`${verdict.id} proven=${verdict.proven} on ${verdict.observations}`
		);
});

test('every leftover Norbital rule with a discriminating harness is proven', () => {
	const leftover = verdicts.filter((verdict) => (LEFTOVER as ReadonlyArray<string>).includes(verdict.id));
	const failures = leftover.flatMap((verdict) => verdict.failures);
	assert.deepEqual(failures, [], failures.join('\n'));
	for (const verdict of leftover)
		assert.ok(verdict.proven, `${verdict.id} has ${verdict.observations} observations and must prove`);
});

test('first-sweep Norbital rules keep their existing proofs', () => {
	const firstSweep = verdicts.filter(
		(verdict) => !(LEFTOVER as ReadonlyArray<string>).includes(verdict.id)
	);
	const failures = firstSweep.flatMap((verdict) => verdict.failures);
	assert.deepEqual(failures, [], failures.join('\n'));
});

const MOVED = [
	'SQL1',
	'LIVE1',
	'CAP_QUERY',
	'UI17',
	'UI6',
	'V1',
	'UI5',
	'CAP_MUTATION',
	'COMPAT1',
	'DDL1',
	'LEGACY1',
	'ORM1',
	'QRY2',
	'QRY4',
	'TRANS1',
	'UI7',
	'UI8',
	'UI12',
	'UI15',
	'UI18',
	'V15'
] as const;

const FIRST_SWEEP_MOVED = ['E2', 'LIVE2', 'QRY3', 'ROOT1', 'TRANS2'] as const;

test('leftover Norbital rules with visitor-era extras are the ones that move', () => {
	for (const id of MOVED) {
		const verdict = leftoverVerdict(id);
		assert.ok(verdict.proven, `${id} has ${verdict.observations} observations: ${verdict.failures.join('; ')}`);
	}
});

test('first-sweep Norbital rules with visitor-era extras are the ones that move', () => {
	const extrasById = new Map<string, number>();
	for (const extra of EXTRAS)
		extrasById.set(extra.id, (extrasById.get(extra.id) ?? 0) + 1);
	for (const id of FIRST_SWEEP_MOVED) {
		const verdict = leftoverVerdict(id);
		assert.ok(
			verdict.proven && (extrasById.get(id) ?? 0) >= FLOOR,
			`${id} has ${verdict.observations} observations and ${extrasById.get(id) ?? 0} extras: ${verdict.failures.join('; ')}`
		);
	}
});

function leftoverVerdict(id: string): Verdict {
	const verdict = verdicts.find((row) => row.id === id);
	assert.ok(verdict !== undefined, `${id} is missing`);
	return verdict;
}
