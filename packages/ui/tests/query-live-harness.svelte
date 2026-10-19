<script lang="ts">
	import type { Stream } from 'effect';
	import { live } from '../src/effect/index.js';
	let { source }: { source: () => Stream.Stream<string | undefined, Error> | null } = $props();
	const view = live(() => source());
</script>

<output>{view.current ?? 'empty'}</output>
<span data-tag>{view.result._tag}</span>
<span data-loading>{String(view.loading)}</span>
<span data-error>{view.error?.message ?? ''}</span>
