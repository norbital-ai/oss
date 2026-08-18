<script lang="ts">
	import type { WorkspaceNavigationModel } from '@norbital-ai/ui/workspace-shell';
	import type { AgentComposerSeed } from '../agent/composer-chrome.js';
	import OmniFinder from './omni-finder.svelte';

	let {
		open = $bindable(false),
		collections = [],
		navigationModel,
		agentAvailable = true,
		onNavigate,
		onAskAgent,
		onOpenRecord
	}: {
		open?: boolean;
		collections?: readonly string[];
		navigationModel: WorkspaceNavigationModel;
		agentAvailable?: boolean;
		onNavigate: (href: string) => void;
		onAskAgent: (seed?: AgentComposerSeed) => void;
		onOpenRecord: (target: { collectionName: string; recordId: string }) => void;
	} = $props();
</script>

<OmniFinder
	bind:open
	{collections}
	{navigationModel}
	{agentAvailable}
	{onNavigate}
	{onAskAgent}
	{onOpenRecord}
/>
