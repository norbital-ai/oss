<script lang="ts">
	import { Sheet } from '@norbital-ai/ui';
	import Agent from '../../src/shell/agent/Agent.svelte';
	import type { ShellApi } from '../../src/shell/api-types.ts';
	import type { ShellBolt } from '../../src/shell/runtime.ts';

	let { api, bolt }: { api: ShellApi; bolt: Pick<ShellBolt, 'observe' | 'fileUrl'> } = $props();
	let open = $state(true);
</script>

<div class="bg-background h-dvh"></div>
<Sheet bind:open title="Norbius">
	<Agent
		{api}
		{bolt}
		t={(key: string) => key}
		request={{ conversation: 'rail-root' }}
		onClose={() => {}}
	/>
</Sheet>
