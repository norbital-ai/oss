<script lang="ts">
	import { Layer, ManagedRuntime } from 'effect';
	import { onDestroy } from 'svelte';
	import { mountEdge } from '../src/effect/index.js';
	onDestroy(mountEdge(ManagedRuntime.make(Layer.empty)));
	// Mounts the built-in `file` field under a host that uploads, serves file URLs and reads `sys_file` / `sys_user`.
	import FileInput from '../src/kinds/file-input.svelte';
	import FileField from '../src/kinds/builtin/file.svelte';
	import { provideKinds, type KindView, type KindsHost } from '../src/kinds/context.js';

	let {
		host,
		view,
		pending
	}: { host: KindsHost; view: KindView; pending?: (busy: boolean) => void } = $props();
	// svelte-ignore state_referenced_locally
	provideKinds(host);
</script>

{#if pending && view.mode === 'edit' && view.kind?.kind === 'file'}
	<FileInput
		kind={view.kind}
		value={view.value}
		name={view.name}
		onChange={view.onChange}
		onPendingChange={pending}
	/>
{:else}<FileField {view} />{/if}
