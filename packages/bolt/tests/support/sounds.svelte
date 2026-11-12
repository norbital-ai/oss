<script lang="ts">
	import { onMount } from 'svelte';
	import { Sheet } from '@norbital-ai/ui';
	import { createSounds, type SoundStatus } from '../../src/shell/sounds.ts';
	import Sounds from '../../src/shell/settings/Sounds.svelte';
	let enabled = $state(true);
	let status = $state<SoundStatus>('needs-gesture');
	const sounds = createSounds(
		() => enabled,
		(value) => {
			status = value;
		}
	);
	onMount(() => () => sounds.close());
</script>

<Sheet open title="Sounds">
	<Sounds
		{enabled}
		{status}
		t={(key) => key}
		on_change={(value) => {
			enabled = value;
			if (value) void sounds.test();
		}}
		on_test={() => {
			void sounds.test();
		}}
	/>
</Sheet>
