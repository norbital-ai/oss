<script lang="ts">
	// Stands in for a form inside a sheet: registers whether it holds an unsaved draft, as `FormBody` does.
	import { getContext, onDestroy } from 'svelte';
	import { SHEET_GUARD, type SheetGuard } from '../src/primitives/sheet/dismiss.js';

	let { dirty }: { dirty: () => boolean } = $props();
	// svelte-ignore state_referenced_locally -- the probe's getter is fixed for its life
	onDestroy(getContext<SheetGuard>(SHEET_GUARD)(() => dirty()));
</script>

<p>draft</p>
