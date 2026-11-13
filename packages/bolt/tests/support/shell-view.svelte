<script lang="ts">
	import type { UiContext } from '@norbital-ai/ui';
	import type { ShellApi } from '../../src/shell/api-types.ts';
	import type { ShellBolt } from '../../src/shell/runtime.ts';
	import { view_client } from '../../src/page/view-client.ts';
	import Runs from '../../src/shell/runs/Runs.svelte';
	import Audit from '../../src/shell/audit/Audit.svelte';
	import Inbox from '../../src/shell/inbox/Inbox.svelte';
	let {
		api,
		bolt,
		t,
		view
	}: { api: ShellApi; bolt: ShellBolt; t: (key: string) => string; view: 'runs' | 'audit' | 'inbox' } =
		$props();
	// svelte-ignore state_referenced_locally
	const ui = view_client(bolt, {}, {});
	const ctx: UiContext = { ui: { bolt: ui, kinds: { locale: 'en', zone: 'UTC' } } };
</script>

{#if view === 'runs'}
	<Runs {ctx} {api} {bolt} {t} on_run={() => {}} />
{:else if view === 'audit'}
	<Audit {ctx} {api} {t} admin locale="en" catalog={bolt.catalog} />
{:else}
	<Inbox {ctx} {bolt} {t} />
{/if}
