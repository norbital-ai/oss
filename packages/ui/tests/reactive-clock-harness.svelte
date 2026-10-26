<script lang="ts">
	import { reactiveClock } from '../src/effect/index.js';
	let { unit, now, zone }: { unit?: 'minute' | 'hour' | 'day'; now: () => Date; zone: string } =
		$props();
	const clock = $derived(reactiveClock((at) => ({ at: at.toISOString() }), unit, zone, now));
</script>

<output>{clock.at}</output>
