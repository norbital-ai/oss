<script lang="ts">
	import { reactive_clock } from '../src/effect/index.js';
	let { unit, now, zone }: { unit?: 'minute' | 'hour' | 'day'; now: () => Date; zone: string } =
		$props();
	const clock = $derived(reactive_clock((at) => ({ at: at.toISOString() }), unit, zone, now));
</script>

<output>{clock.at}</output>
