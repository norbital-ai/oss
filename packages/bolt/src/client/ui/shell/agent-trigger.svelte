<script lang="ts">
	/**
	 * The workspace agent's entry point, as a sidebar row.
	 *
	 * It used to be a floating button pinned to the bottom-right of the viewport, where it sat on top
	 * of whatever was underneath — in a collection that is the last row and the pagination control.
	 * Nothing about the agent needs to float: it is a destination like any other, so it takes the top
	 * slot of the navigation and scrolls with it.
	 *
	 * The row is wide enough to say its own name, so the shortcut is printed inline rather than hidden
	 * in a tooltip. Collapsed, there is no room for either, and the tooltip carries both.
	 */
	import * as Sidebar from '@norbital-ai/ui/sidebar';
	import { cn } from '@norbital-ai/ui/utils';
	import { WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS } from '@norbital-ai/ui/workspace-shell';
	import { ThinkingOrb as NorbitalThinkingOrb } from '@norbital-ai/ui/thinking-orb';
	import type { AgentOrbState } from '../agent/agent-orb-state.js';

	let {
		state,
		label,
		shortcut,
		expanded = true,
		onclick
	}: {
		state: AgentOrbState;
		/** The visible name of the action, e.g. "Ask agent". */
		label: string;
		/** Rendered shortcut, e.g. "⌘K". */
		shortcut?: string;
		expanded?: boolean;
		onclick?: () => void;
	} = $props();
</script>

<Sidebar.MenuButton
	tooltipContent={shortcut ? `${label} · ${shortcut}` : label}
	aria-label={shortcut ? `${label} (${shortcut})` : label}
	aria-haspopup="dialog"
	{onclick}
	data-testid="workspace-agent-trigger"
	class={cn(
		'rounded-md text-xs hover:bg-accent data-[state=open]:bg-accent',
		expanded ? 'h-8 px-2' : 'size-8 justify-center p-0'
	)}
>
	<!--
		The same box every other sidebar icon sits in, so the orb lands where a `size-4` glyph lands.

		`Notifications` beside it is `IconWrapper class="size-4 shrink-0"`, and the agent sheet's own
		header already wrapped its orb this way — this trigger was the one call site left rendering the
		orb bare. The orb is 16px and `flex: none` on its own, so nothing was resizing it; what it
		lacked was the fixed grid cell its neighbours are centred in, which is what makes a row of
		icons share one optical axis rather than each sitting wherever its own glyph falls.

		No label on the orb: the button already carries one, and a second would be read twice.
	-->
	<div class="grid size-4 shrink-0 place-items-center">
		<NorbitalThinkingOrb {state} size={16} />
	</div>
	{#if expanded}
		<span class="min-w-0 flex-1 truncate text-left {WORKSPACE_SIDEBAR_ITEM_TEXT_CLASS}"
			>{label}</span
		>
		{#if shortcut}
			<kbd
				class="pointer-events-none ml-auto hidden h-5 select-none items-center rounded-md border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground sm:inline-flex"
				data-testid="workspace-agent-shortcut"
				aria-hidden="true">{shortcut}</kbd
			>
		{/if}
	{/if}
</Sidebar.MenuButton>
