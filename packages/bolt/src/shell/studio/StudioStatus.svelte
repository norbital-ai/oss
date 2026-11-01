<!--
	The change's status beside Studio's title: how far behind live it is, and what a run is doing (working, a phase, a
	failure, conflicts) or that it finished. It lives in the app header, not the toolbar.
-->
<script lang="ts">
	import { Badge, Icon, type BadgeVariant } from '@norbital-ai/ui';
	import { PHASES, type PhaseState, type StudioPhase, type StudioView } from './model.ts';

	let {
		view,
		busy,
		phases,
		t
	}: {
		view: StudioView;
		busy: boolean;
		phases: { readonly [p in StudioPhase]?: PhaseState };
		t: (key: string) => string;
	} = $props();

	const change = $derived(view.changeSets?.find((c) => c.id === view.change));
	const behind = $derived(view.behind ?? 0);
	const merging = $derived(change?.merge?.state === 'running');
	const scheduled = $derived(
		change?.merge?.state === 'scheduled' && change.merge.runAt !== undefined
			? new Date(change.merge.runAt).toLocaleString()
			: null
	);
	const phaseTitle = (p: StudioPhase) =>
		t(
			p === 'diagnose'
				? 'Building'
				: p === 'copy'
					? 'Copying data'
					: p === 'preview'
						? 'Preview'
						: 'Merge'
		);
	const status = $derived.by(
		(): {
			label: string;
			detail?: string;
			icon: string;
			variant: BadgeVariant;
			loading?: true;
		} | null => {
			const running = PHASES.find((p) => phases[p] === 'running');
			const failed = PHASES.find((p) => phases[p] === 'failed');
			if (busy || running !== undefined || merging)
				return {
					label:
						running === undefined
							? t(merging ? 'Merging…' : 'Working…')
							: `${phaseTitle(running)}…`,
					icon: 'lucide:loader-2',
					variant: 'outline',
					loading: true
				};
			if (scheduled !== null)
				return {
					label: `${t('Merges at')} ${scheduled}`,
					icon: 'lucide:clock',
					variant: 'outline'
				};
			if (change?.merge?.state === 'failed')
				return {
					label: t('Merge failed'),
					...(change.merge.error === undefined ? {} : { detail: change.merge.error }),
					icon: 'lucide:circle-alert',
					variant: 'destructive'
				};
			if (failed !== undefined)
				return {
					label: `${phaseTitle(failed)} · ${t('failed')}`,
					icon: 'lucide:circle-alert',
					variant: 'destructive'
				};
			if ((view.conflicts?.length ?? 0) > 0)
				return {
					label: t('Action required'),
					detail: `${t('Resolve the conflict markers in')} ${view.conflicts?.join(', ')}`,
					icon: 'lucide:triangle-alert',
					variant: 'warning'
				};
			if (phases.preview === 'done' || phases.merge === 'done')
				return { label: t('Updated'), icon: 'lucide:circle-check', variant: 'success' };
			return null;
		}
	);
</script>

{#if behind > 0}
	<Badge variant="warning" class="h-5 max-w-48 shrink-0 px-2 py-0 text-micro"
		>{behind} {t('behind live')}</Badge
	>
{/if}
{#if status !== null}
	<Badge
		variant={status.variant}
		class="h-5 max-w-48 shrink-0 gap-1 px-2 py-0 text-micro"
		title={status.detail}
		aria-busy={status.loading}
	>
		<Icon name={status.icon} class="size-3 shrink-0 {status.loading ? 'animate-spin' : ''}" /><span
			class="truncate">{status.label}</span
		>
	</Badge>
{/if}
