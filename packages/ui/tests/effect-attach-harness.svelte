<script lang="ts">
	import { Effect } from 'effect';
	import { attach } from '../src/effect/index.js';
	let { seen }: { seen: (event: 'start' | 'stop', selected: number, value: number) => void } =
		$props();
	let selected = $state(0);
	let internal = $state(0);
	const bind = attach<HTMLDivElement>(() => {
		const input = selected;
		return Effect.gen(function* () {
			seen('start', input, internal);
			yield* Effect.addFinalizer(() => Effect.sync(() => seen('stop', input, internal)));
			yield* Effect.never;
		});
	});
</script>

<button onclick={() => internal++}>Internal state</button>
<button onclick={() => selected++}>Factory input</button>
<div {@attach bind}></div>
