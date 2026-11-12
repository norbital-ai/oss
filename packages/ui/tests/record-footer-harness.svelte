<script lang="ts" module>
	import type { Outcome, ViewBolt } from '../src/client/contract.js';
	import type { KindsHost } from '../src/kinds/context.js';

	export type FooterFixtureOptions = {
		readonly representation: 'generated' | 'raw' | 'decorated';
		readonly independent_form: boolean;
		readonly form_actions: boolean;
		readonly lock: string | undefined;
		on_native_action(): void;
		on_form_action(): void;
	};
	export type RecordFooterHarnessProps = {
		bolt: ViewBolt;
		catalog: NonNullable<KindsHost['catalog']>;
		layout?: 'sheet' | 'page';
		representation?: FooterFixtureOptions['representation'];
		mode?: 'view' | 'edit' | 'create';
		id?: string;
		independent_form?: boolean;
		form_actions?: boolean;
		lock?: string;
		on_native_action?: () => void;
		on_form_action?: () => void;
		on_done?: (outcome: Outcome) => void;
	};
</script>

<script lang="ts">
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy, setContext, untrack } from 'svelte';
	import { mount_edge } from '../src/effect/index.js';
	import { provide_bolt } from '../src/client/context.js';
	import { provide_kinds } from '../src/kinds/context.js';
	import { provide_representations } from '../src/record/context.js';
	import RecordShell from '../src/record/RecordShell.svelte';
	import Sheet from '../src/primitives/sheet/sheet.svelte';

	let {
		bolt,
		catalog,
		layout = 'sheet',
		representation = 'decorated',
		mode = 'view',
		id = 'j1',
		independent_form = false,
		form_actions = false,
		lock,
		on_native_action,
		on_form_action,
		on_done
	}: RecordFooterHarnessProps = $props();
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	provide_bolt(() => bolt);
	provide_kinds({
		get catalog() {
			return catalog;
		},
		query: (request) => bolt.query(request)
	});
	setContext<FooterFixtureOptions>('test.record.footer', {
		get representation() {
			return representation;
		},
		get independent_form() {
			return independent_form;
		},
		get form_actions() {
			return form_actions;
		},
		get lock() {
			return lock;
		},
		on_native_action: () => on_native_action?.(),
		on_form_action: () => on_form_action?.()
	});
	// Exercise the actual registered representation branch, rather than passing children to the outer shell.
	if (untrack(() => representation !== 'generated'))
		provide_representations({ jobs: () => import('./record-footer-representation.svelte') });
</script>

{#snippet record()}
	<RecordShell of="jobs" id={mode === 'create' ? undefined : id} {mode} {lock} {on_done} />
{/snippet}

{#if layout === 'sheet'}
	<Sheet open>{@render record()}</Sheet>
{:else}
	<div style="height:100dvh;min-height:0" data-footer-page>{@render record()}</div>
{/if}
