<!-- The approval requests waiting on the member's decision, live wherever they are: the Approvals entry's count. -->
<script lang="ts">
	import { observe } from '@norbital-ai/ui/effect';
	import { watch } from 'runed';
	import type { ShellBolt } from '../runtime.ts';
	import type { InboxRequest } from './data.ts';

	let { bolt, onCount }: { bolt: ShellBolt; onCount: (n: number) => void } = $props();
	// svelte-ignore state_referenced_locally
	const inbox = observe(() =>
		bolt.observe<{ requests: readonly InboxRequest[] }>({
			read: { m: 'inbox', a: [{ requests: true }] }
		})
	);
	watch(
		() => inbox.current,
		(value) => {
			if (value !== undefined) onCount(value.requests.filter((r) => r.canDecide).length);
		}
	);
</script>
