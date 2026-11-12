<script lang="ts">
	import type { UiContext } from '../src/client/contract.js';
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mount_edge } from '../src/effect/index.js';
	onDestroy(mount_edge(ManagedRuntime.make(Layer.empty)));
	// Mounts the built-in `file` field under a host that uploads, serves file URLs and reads `sys_file` / `sys_user`.
	import FileInput from '../src/kinds/file-input.svelte';
	import FileField from '../src/kinds/builtin/file.svelte';
	import { type KindView, type KindsHost } from '../src/kinds/context.js';

	let {
		host,
		view,
		pending
	}: { host: KindsHost; view: KindView; pending?: (busy: boolean) => void } = $props();
	// svelte-ignore state_referenced_locally
	const ctx: UiContext = { ui: { kinds: host } };
</script>

{#if pending && view.mode === 'edit' && view.kind?.kind === 'file'}
	<FileInput {ctx}
		kind={view.kind}
		value={view.value}
		name={view.name}
		on_change={view.on_change}
		on_pending_change={pending}
	/>
{:else}<FileField {ctx} {view} />{/if}
