<script lang="ts">
	// A `point` field with the host's kinds (G5): zero providers, or a geocoder when the host has one.
	import { provideKinds, type KindsHost } from '../../../ui/src/kinds/context.js';
	import PointInput from '../../../ui/src/kinds/point-input.svelte';
	import type { Json } from '../../../ui/src/kinds/kind.js';

	let { kinds, onChange }: { kinds: KindsHost; onChange: (v: Json) => void } = $props();
	// svelte-ignore state_referenced_locally
	provideKinds(kinds);
	let value = $state<Json>(null);
</script>

<PointInput {value} onChange={(v) => { value = v; onChange(v); }} />
