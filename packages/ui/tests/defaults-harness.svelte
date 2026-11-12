<script lang="ts" module>
	import type { UiContext } from '../src/client/contract.js';
	import type { ComponentProps } from 'svelte';
	import type { KindsHost } from '../src/kinds/context.js';
	import type { ViewBolt } from '../src/client/contract.js';
	import type { Values } from '../src/model/types.js';
	import NativeTable, { type TableSource } from '../src/table/Table.svelte';
	const Table = NativeTable<TableSource>;
	import type { CustomViewProps } from '../src/model/CustomView.svelte';
	export type DefaultsPart =
		| { part: 'table'; props: Omit<ComponentProps<typeof Table>, 'ctx'> }
		| { part: 'record'; props: Omit<ComponentProps<typeof RecordShell>, 'ctx'> }
		| { part: 'form'; props: Omit<ComponentProps<typeof Form>, 'ctx'> }
		| { part: 'show'; props: Omit<ComponentProps<typeof Show>, 'ctx'> }
		| { part: 'custom'; props: Omit<CustomViewProps<Values>, 'ctx' | 'children'> }
		| { part: 'markdown'; props?: Record<string, never> };
	export type DefaultsHarnessProps = DefaultsPart & {
		bolt: ViewBolt;
		catalog: NonNullable<KindsHost['catalog']>;
	};
</script>

<script lang="ts">
	// Mounts one kit part under a scripted `bolt` and catalog, for the kit's default display (the template UI audit).
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mount_edge } from '../src/effect/index.js';
	import Show from '../src/kinds/show.svelte';
	import Form from '../src/form/form.svelte';
	import ReadonlyMarkdown from '../src/editors/readonly-markdown.svelte';
	import Sheet from '../src/primitives/sheet/sheet.svelte';
	import CustomView from '../src/model/CustomView.svelte';
	import RecordShell from '../src/record/RecordShell.svelte';

	let fixture: DefaultsHarnessProps = $props();
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	// svelte-ignore state_referenced_locally
	const ctx: UiContext = { ui: { bolt: fixture.bolt, kinds: {
		get catalog() {
			return fixture.catalog;
		},
		query: (request) => fixture.bolt.query(request),
		locale: 'en',
		zone: 'UTC',
		currency: 'SGD'
	} } };
</script>

{#snippet rows(list: readonly object[])}<p data-custom-rows>{list.length}</p>{/snippet}

{#if fixture.part === 'table'}<Table {ctx} {...fixture.props} />
{:else if fixture.part === 'record'}<Sheet open title="record"
		><RecordShell {ctx} {...fixture.props} /></Sheet
	>
{:else if fixture.part === 'form'}<Form {ctx} {...fixture.props} />
{:else if fixture.part === 'show'}<Show {ctx} {...fixture.props} />
{:else if fixture.part === 'custom'}<CustomView {ctx} {...fixture.props} children={rows} />
{:else}<ReadonlyMarkdown value="**bold**" data-probe="md" />{/if}
