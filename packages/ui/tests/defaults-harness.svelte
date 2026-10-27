<script lang="ts" module>
	import type { ComponentProps } from 'svelte';
	import type { KindsHost } from '../src/kinds/context.js';
	import type { ViewBolt } from '../src/client/contract.js';
	import type { Values } from '../src/model/types.js';
	import NativeTable, { type TableSource } from '../src/table/Table.svelte';
	const Table = NativeTable<TableSource>;
	import type { CustomViewProps } from '../src/model/CustomView.svelte';
	export type DefaultsPart =
		| { part: 'table'; props: ComponentProps<typeof Table> }
		| { part: 'record'; props: ComponentProps<typeof RecordShell> }
		| { part: 'form'; props: ComponentProps<typeof Form> }
		| { part: 'show'; props: ComponentProps<typeof Show> }
		| { part: 'custom'; props: Omit<CustomViewProps<Values>, 'children'> }
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
	import { mountEdge } from '../src/effect/index.js';
	import { provideKinds } from '../src/kinds/context.js';
	import Show from '../src/kinds/show.svelte';
	import Form from '../src/form/form.svelte';
	import ReadonlyMarkdown from '../src/editors/readonly-markdown.svelte';
	import Sheet from '../src/primitives/sheet/sheet.svelte';
	import { provideBolt } from '../src/client/context.js';
	import CustomView from '../src/model/CustomView.svelte';
	import RecordShell from '../src/record/RecordShell.svelte';

	let fixture: DefaultsHarnessProps = $props();
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	// svelte-ignore state_referenced_locally
	provideBolt(fixture.bolt);
	provideKinds({
		get catalog() {
			return fixture.catalog;
		},
		query: (request) => fixture.bolt.query(request),
		locale: 'en',
		zone: 'UTC',
		currency: 'SGD'
	});
</script>

{#snippet rows(list: readonly object[])}<p data-custom-rows>{list.length}</p>{/snippet}

{#if fixture.part === 'table'}<Table {...fixture.props} />
{:else if fixture.part === 'record'}<Sheet open title="record"
		><RecordShell {...fixture.props} /></Sheet
	>
{:else if fixture.part === 'form'}<Form {...fixture.props} />
{:else if fixture.part === 'show'}<Show {...fixture.props} />
{:else if fixture.part === 'custom'}<CustomView {...fixture.props} children={rows} />
{:else}<ReadonlyMarkdown value="**bold**" data-probe="md" />{/if}
