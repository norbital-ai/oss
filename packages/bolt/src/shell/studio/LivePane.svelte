<!-- Tenant Studio and Realm render the same operational inspection; Studio keeps source and the preview editor beside it. -->
<script lang="ts">
	import {
		WorkspaceOperations,
		type WorkspaceOperation,
		type WorkspaceOperationsData,
		type WorkspaceRange,
		type WorkspaceView,
		type WorkspaceScope
	} from '@norbital-ai/ui';
	import { observeOnce } from '@norbital-ai/ui/effect';
	import { Scroll } from '@norbital-ai/ui/layout';
	import { watch } from 'runed';
	import type { Effect } from 'effect';
	import type { StudioView } from './model.ts';
	import type { ShellApi } from '../api-types.ts';
	import { based } from '../nav.ts';
	let {
		api,
		view,
		admin,
		busy,
		sub,
		onsub,
		onoperate,
		t
	}: {
		api: ShellApi;
		view: StudioView;
		admin: boolean;
		busy: boolean;
		sub: 'runtime' | 'operations' | 'usage';
		onsub: (sub: 'runtime' | 'operations' | 'usage') => void;
		onoperate: (operation: WorkspaceOperation) => Effect.Effect<unknown, Error>;
		t: (key: string) => string;
	} = $props();
	let range = $state<WorkspaceRange>('7d');
	let chosen = $state<WorkspaceView | null>(null);
	let build = $state<string | null>(null),
		run = $state<string | null>(null);
	const route = (value: WorkspaceView) =>
		value === 'resources' ? 'usage' : value === 'logs' ? 'runtime' : 'operations';
	const active = $derived(
		chosen ?? (sub === 'usage' ? 'resources' : sub === 'runtime' ? 'logs' : 'activity')
	);
	watch(
		() => sub,
		(next) => {
			if (chosen !== null && route(chosen) !== next) chosen = null;
		}
	);
	// one snapshot serves every sub-tab: switching a pane is a local render, never another read
	const input = $derived({ range, build, run });
	const inspection = observeOnce(() => {
		// Native operations and background merge frames replace view; refresh the shared inspection with that state.
		void view;
		return admin ? api.studioInspect(input) : null;
	});
	// a new view reads while the last one stays on screen: the shell never empties between sub-tabs
	let shown = $state<WorkspaceOperationsData | null>(null);
	watch(
		() => inspection.current,
		(next) => {
			if (next !== undefined) shown = next;
		}
	);
	const data = $derived(inspection.current ?? shown);
	function change(next: WorkspaceScope) {
		if (next.range !== undefined) range = next.range;
		if (next.build !== undefined) build = next.build;
		if (next.run !== undefined) run = next.run;
		if (next.view !== undefined) {
			chosen = next.view;
			onsub(route(next.view));
		}
	}
</script>

<Scroll name={t('Workspace operations')} class="h-full min-h-0">
	<div class="grid min-w-0 gap-3 px-4 pb-4 sm:px-6 sm:pb-6">
		{#if !admin}<p class="text-meta">{t('Workspace operations are an administrator’s.')}</p>
		{:else}
			{#if inspection.error !== undefined}<p role="alert" class="text-destructive text-xs">
					{inspection.error.message}
				</p>{/if}
			{#if data === null}<p class="text-meta" role="status">
					{t('Reading workspace operations…')}
				</p>
			{:else}<WorkspaceOperations
					{data}
					scopeKey={based('')}
					{range}
					view={active}
					busy={busy || inspection.loading}
					onChange={change}
					onOperate={onoperate}
					{t}
				/>{/if}
		{/if}
	</div>
</Scroll>
