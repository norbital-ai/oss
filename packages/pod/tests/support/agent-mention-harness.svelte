<script lang="ts">
	import { setPlatformStateContext } from '$lib/ui/state/platform_state.svelte.js';
	import type { Component } from 'svelte';

	/**
	 * The platform-state context, and only it.
	 *
	 * The agent panel reads the manifest through `getPlatformStateContext()` to know what "@" can
	 * reference. Standing up the whole shell for that would drag the router and the real manifest
	 * into a test about a menu; this harness supplies the one getter the panel touches.
	 */
	let {
		component: Subject,
		props,
		manifestContext
	}: {
		component: Component<Record<string, unknown>, Record<string, unknown>, string>;
		props: Record<string, unknown>;
		manifestContext: unknown;
	} = $props();

	setPlatformStateContext(() => ({ manifestContext }) as never);
</script>

<Subject {...props} />
