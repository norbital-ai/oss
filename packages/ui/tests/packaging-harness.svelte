<script lang="ts" module>
	import type { ComponentProps } from 'svelte';
	import type { KindsHost } from '../src/kinds/context.js';
	import type { ViewBolt } from '../src/client/contract.js';
	import NativeTable, { type TableSource } from '../src/table/Table.svelte';
	const Table = NativeTable<TableSource>;
	export type PackagingPart =
		| { part: 'form'; props: ComponentProps<typeof Form> }
		| { part: 'table'; props: ComponentProps<typeof Table> }
		| { part: 'show'; props: ComponentProps<typeof Show> }
		| { part: 'record'; props: ComponentProps<typeof RecordShell> }
		| { part: 'controls'; props: ComponentProps<typeof Controls> };
	export type PackagingHarnessProps = PackagingPart & {
		bolt: ViewBolt;
		catalog: NonNullable<KindsHost['catalog']>;
		customFields?: KindsHost['customFields'];
		representations?: Parameters<typeof provideRepresentations>[0];
	};
</script>

<script lang="ts">
	// Mounts one kit part under a scripted `bolt`, catalog, custom fields and representation registry.
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mountEdge } from '../src/effect/index.js';
	import { provideKinds } from '../src/kinds/context.js';
	import Show from '../src/kinds/show.svelte';
	import Controls from './controls-harness.svelte';
	import Form from '../src/form/form.svelte';
	import { provideBolt } from '../src/client/context.js';
	import { provideRepresentations } from '../src/record/context.js';
	import RecordShell from '../src/record/RecordShell.svelte';

	let fixture: PackagingHarnessProps = $props();
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	// svelte-ignore state_referenced_locally
	provideBolt(fixture.bolt);
	// svelte-ignore state_referenced_locally
	provideKinds({
		get catalog() {
			return fixture.catalog;
		},
		get customFields() {
			return fixture.customFields;
		},
		query: (request) => fixture.bolt.query(request)
	});
	// svelte-ignore state_referenced_locally
	provideRepresentations(fixture.representations ?? {});
</script>

{#if fixture.part === 'form'}<Form {...fixture.props} />
{:else if fixture.part === 'table'}<Table {...fixture.props} />
{:else if fixture.part === 'show'}<Show {...fixture.props} />
{:else if fixture.part === 'controls'}<Controls {...fixture.props} />
{:else}<RecordShell {...fixture.props} />{/if}
