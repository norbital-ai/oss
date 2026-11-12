<script lang="ts" module>
	import type { UiContext } from '../src/client/contract.js';
	import type { ComponentProps } from 'svelte';
	import type { KindsHost } from '../src/kinds/context.js';
	import type { ViewBolt } from '../src/client/contract.js';
	import NativeTable, { type TableSource } from '../src/table/Table.svelte';
	const Table = NativeTable<TableSource>;
	export type PackagingPart =
		| { part: 'form'; props: Omit<ComponentProps<typeof Form>, 'ctx'> }
		| { part: 'table'; props: Omit<ComponentProps<typeof Table>, 'ctx'> }
		| { part: 'show'; props: Omit<ComponentProps<typeof Show>, 'ctx'> }
		| { part: 'record'; props: Omit<ComponentProps<typeof RecordShell>, 'ctx'> }
		| { part: 'controls'; props: Omit<ComponentProps<typeof Controls>, 'ctx'> };
	export type PackagingHarnessProps = PackagingPart & {
		bolt: ViewBolt;
		catalog: NonNullable<KindsHost['catalog']>;
		customFields?: KindsHost['custom_fields'];
		representations?: Parameters<typeof provide_representations>[0];
	};
</script>

<script lang="ts">
	// Mounts one kit part under a scripted `bolt`, catalog, custom fields and representation registry.
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mount_edge } from '../src/effect/index.js';
	import Show from '../src/kinds/show.svelte';
	import Controls from './controls-harness.svelte';
	import Form from '../src/form/form.svelte';
	import { provide_representations } from '../src/record/context.js';
	import RecordShell from '../src/record/RecordShell.svelte';

	let fixture: PackagingHarnessProps = $props();
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	// svelte-ignore state_referenced_locally
	const ctx: UiContext = { ui: { bolt: fixture.bolt, kinds: {
		get catalog() {
			return fixture.catalog;
		},
		get custom_fields() {
			return fixture.customFields;
		},
		query: (request) => fixture.bolt.query(request)
	} } };
	// svelte-ignore state_referenced_locally
	provide_representations(fixture.representations ?? {});
</script>

{#if fixture.part === 'form'}<Form {ctx} {...fixture.props} />
{:else if fixture.part === 'table'}<Table {ctx} {...fixture.props} />
{:else if fixture.part === 'show'}<Show {ctx} {...fixture.props} />
{:else if fixture.part === 'controls'}<Controls {ctx} {...fixture.props} />
{:else}<RecordShell {ctx} {...fixture.props} />{/if}
