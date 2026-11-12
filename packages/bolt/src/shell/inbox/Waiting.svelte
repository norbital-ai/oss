<!-- The approval requests waiting on the member's decision, live wherever they are: the Approvals entry's count. -->
<script lang="ts">
	import { observe } from '@norbital-ai/ui/effect';
	import { watch } from 'runed';
	import type { ShellBolt } from '../runtime.ts';
	import { InboxReadAnswer } from '../api-types.ts';

	let { bolt, on_count }: { bolt: ShellBolt; on_count: (n: number) => void } = $props();
	// svelte-ignore state_referenced_locally
	const inbox = observe(() =>
		bolt.observe({
			read: { m: 'inbox', a: [{ requests: true }] }
		}, InboxReadAnswer)
	);
	watch(
		() => inbox.current,
		(value) => {
			if (value !== undefined) on_count(value.requests.filter((r) => r.canDecide).length);
		}
	);
</script>
