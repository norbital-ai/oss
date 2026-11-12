<script lang="ts">
	import { Sheet } from '@norbital-ai/ui';
	import Agent from '../../src/shell/agent/Agent.svelte';
	import type { ShellApi } from '../../src/shell/api-types.ts';
	import type { ShellBolt } from '../../src/shell/runtime.ts';
	import type { FinderRead } from '../../src/shell/finder/model.ts';

	let { api, bolt, read }: { api: ShellApi; bolt: Pick<ShellBolt, 'observe' | 'file_url'>; read: FinderRead } =
		$props();
	let open = $state(true);
</script>

<div class="bg-background h-dvh"></div>
<Sheet bind:open title="Norbius">
	<Agent
		{api}
		{bolt}
		{read}
		t={(key: string) => key}
		request={{ conversation: 'rail-root' }}
	/>
</Sheet>
