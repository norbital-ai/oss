<!--
	Settings → Organization → Teams: interactive organization chart built with `@xyflow/svelte`.
	Parent-child edges show reporting/data-scoping structure; dragging from a parent's bottom handle
	to another team's top handle reparents it; clicking any team opens its form sheet to edit name,
	parent, policies or delete it.
-->
<script lang="ts">
	import '@xyflow/svelte/dist/style.css';
	import {
		Background,
		BackgroundVariant,
		ConnectionLineType,
		Controls,
		MarkerType,
		SvelteFlow,
		type Connection,
		type Edge,
		type Node,
		type NodeTypes
	} from '@xyflow/svelte';
	import { Effect } from 'effect';
	import { fork } from '@norbital-ai/ui/effect';
	import {
		Button,
		Combobox,
		confirm_action,
		EmptyState,
		Field,
		Form,
		Icon,
		Input,
		Sheet,
		type UiContext
	} from '@norbital-ai/ui';
	import type { ShellBolt } from '../runtime.ts';
	import type { Settings } from './data.ts';
	import TeamNode, { type TeamNodeData } from './TeamNode.svelte';

	let {
		ctx,
		bolt,
		settings,
		t,
		reload
	}: {
		ctx: UiContext;
		bolt: ShellBolt;
		settings: Settings;
		t: (key: string) => string;
		reload: () => Effect.Effect<void>;
	} = $props();

	type Team = Settings['teams'][number];
	const NODE_W = 248;
	const GAP_X = 36;
	const LEVEL_Y = 148;

	let creating = $state(false);
	let createParent = $state<string | null>(null);
	let editing = $state<string | null>(null);
	let error = $state<string | null>(null);
	let layoutRevision = $state(0);

	const editing_team = $derived(settings.teams.find((team) => team.id === editing));
	const sheetOpen = $derived(creating || editing_team !== undefined);

	const memberCounts = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const member of settings.members) {
			if (member.team !== null) counts.set(member.team, (counts.get(member.team) ?? 0) + 1);
		}
		return counts;
	});

	const openCreate = (parentId: string | null = null) => {
		editing = null;
		createParent = parentId;
		creating = true;
		error = null;
	};
	const openEdit = (id: string) => {
		creating = false;
		createParent = null;
		editing = id;
		error = null;
	};
	const closeSheet = () => {
		creating = false;
		createParent = null;
		editing = null;
		error = null;
	};
	const saved = (kind: string) => {
		if (kind !== 'committed') return;
		closeSheet();
		fork(reload());
	};

	/** Rejects self-parenting and cycles when dragging an edge in the org chart. */
	const wouldCycle = (parentId: string, childId: string): boolean => {
		if (parentId === childId) return true;
		const byId = new Map(settings.teams.map((team) => [team.id, team.parent]));
		let cursor: string | null | undefined = parentId;
		const seen = new Set<string>();
		while (cursor != null) {
			if (cursor === childId) return true;
			if (seen.has(cursor)) return true;
			seen.add(cursor);
			cursor = byId.get(cursor);
		}
		return false;
	};

	/** Computes deterministic top-down org-chart coordinates for every team subtree. */
	function layoutTeams(teams: readonly Team[]): Map<string, { x: number; y: number }> {
		const byId = new Map(teams.map((team) => [team.id, team]));
		const children = new Map<string, Team[]>();
		const roots: Team[] = [];
		for (const team of teams) {
			if (team.parent !== null && team.parent !== team.id && byId.has(team.parent)) {
				const list = children.get(team.parent);
				if (list === undefined) children.set(team.parent, [team]);
				else list.push(team);
			} else {
				roots.push(team);
			}
		}
		const widths = new Map<string, number>();
		const measure = (id: string, stack: Set<string>): number => {
			const cached = widths.get(id);
			if (cached !== undefined) return cached;
			if (stack.has(id)) return NODE_W;
			stack.add(id);
			const kids = children.get(id) ?? [];
			const total =
				kids.length === 0
					? NODE_W
					: Math.max(
							NODE_W,
							kids.reduce((sum, kid) => sum + measure(kid.id, stack), 0) +
								(kids.length - 1) * GAP_X
						);
			stack.delete(id);
			widths.set(id, total);
			return total;
		};
		for (const root of roots) measure(root.id, new Set());
		// Any team stranded in a broken cycle still gets laid out cleanly as a root.
		for (const team of teams) {
			if (!widths.has(team.id)) {
				roots.push(team);
				measure(team.id, new Set());
			}
		}
		const positions = new Map<string, { x: number; y: number }>();
		const place = (team: Team, left: number, depth: number, placed: Set<string>) => {
			if (placed.has(team.id)) return;
			placed.add(team.id);
			const span = widths.get(team.id) ?? NODE_W;
			positions.set(team.id, { x: left + (span - NODE_W) / 2, y: depth * LEVEL_Y });
			let cursor = left;
			for (const kid of children.get(team.id) ?? []) {
				const kidSpan = widths.get(kid.id) ?? NODE_W;
				place(kid, cursor, depth + 1, placed);
				cursor += kidSpan + GAP_X;
			}
		};
		const placed = new Set<string>();
		let offset = 0;
		for (const root of roots) {
			const span = widths.get(root.id) ?? NODE_W;
			place(root, offset, 0, placed);
			offset += span + GAP_X * 1.5;
		}
		return positions;
	}

	const nodeTypes: NodeTypes = { team: TeamNode };

	let nodes = $state.raw<Node<TeamNodeData>[]>([]);
	let edges = $state.raw<Edge[]>([]);

	$effect(() => {
		void layoutRevision;
		const positions = layoutTeams(settings.teams);
		const byId = new Set(settings.teams.map((team) => team.id));
		nodes = settings.teams.map((team) => ({
			id: team.id,
			type: 'team',
			position: positions.get(team.id) ?? { x: 0, y: 0 },
			data: {
				team,
				members: memberCounts.get(team.id) ?? 0,
				selected: editing === team.id,
				t,
				onEdit: openEdit,
				onAddChild: (parentId: string) => openCreate(parentId)
			}
		}));
		edges = settings.teams.flatMap((team): Edge[] =>
			team.parent !== null && byId.has(team.parent) && team.parent !== team.id
				? [
						{
							id: `${team.parent}->${team.id}`,
							source: team.parent,
							target: team.id,
							type: 'smoothstep',
							markerEnd: {
								type: MarkerType.ArrowClosed,
								width: 14,
								height: 14,
								color: 'var(--muted-foreground)'
							},
							style: 'stroke: var(--border-control, var(--border)); stroke-width: 1.5px;'
						}
					]
				: []
		);
	});

	const reparent = (connection: Connection) => {
		const { source, target } = connection;
		if (!source || !target) return;
		if (wouldCycle(source, target)) {
			error = t('A team cannot report to itself or one of its own sub-teams.');
			return;
		}
		const current = settings.teams.find((team) => team.id === target);
		if (current === undefined || current.parent === source) return;
		error = null;
		fork(
			bolt.act({ 'sys_team.update': [{ target: { id: target }, set: { parent: source } }] }).pipe(
				Effect.tap((outcome) =>
					Effect.sync(() => {
						if (outcome.kind !== 'committed') {
							error = t('Could not update the parent team.');
						}
					})
				),
				Effect.andThen(reload())
			),
			(cause) => {
				error = cause.message;
			}
		);
	};

	const remove = (team: Team) =>
		fork(
			confirm_action({
				title: t('Delete {name}?').replace('{name}', team.name),
				body: t(
					'A team that a member, an invitation, an API key or another team still names cannot be deleted.'
				),
				confirm_label: t('Delete'),
				cancel_label: t('Cancel'),
				destructive: true
			}).pipe(
				Effect.flatMap((confirmed) =>
					confirmed
						? bolt.act({ 'sys_team.delete': [{ target: { id: team.id } }] }).pipe(
								Effect.tap((outcome) =>
									Effect.sync(() => {
										if (outcome.kind === 'committed') closeSheet();
									})
								),
								Effect.andThen(reload())
							)
						: Effect.void
				)
			),
			(cause) => {
				error = cause.message;
			}
		);
</script>

<!-- `self` is the team being edited: it is no parent of itself -->
{#snippet fields(self: string | null)}
	<Field {ctx} name="name" label={t('Name')}>
		{#snippet editor(field)}
			<Input
				id={field.id}
				value={typeof field.value === 'string' ? field.value : ''}
				disabled={field.disabled}
				oninput={(event) =>
					field.on_change(event.currentTarget.value === '' ? null : event.currentTarget.value)}
			/>
		{/snippet}
	</Field>
	<Field {ctx} name="parent" label={t('Parent team')}>
		{#snippet editor(field)}
			<Combobox
				id={field.id}
				clearable
				aria-label={t('Parent team')}
				placeholder={t('No parent')}
				options={settings.teams
					.filter((team) => team.id !== self && (self === null || !wouldCycle(team.id, self)))
					.map((team) => ({ value: team.id, label: team.name }))}
				value={typeof field.value === 'string' ? field.value : null}
				on_change={field.on_change}
				disabled={field.disabled}
			/>
		{/snippet}
	</Field>
	<Field {ctx} name="policies" label={t('Policies')}>
		{#snippet editor(field)}
			<Combobox
				id={field.id}
				multiple
				aria-label={t('Policies')}
				placeholder={t('Choose policies')}
				options={settings.policies.map((policy) => ({ value: policy, label: policy }))}
				value={Array.isArray(field.value)
					? field.value.filter((value): value is string => typeof value === 'string')
					: []}
				on_change={field.on_change}
				disabled={field.disabled}
			/>
		{/snippet}
	</Field>
{/snippet}

<div class="flex h-full min-h-[26rem] flex-1 flex-col gap-3" data-teams-org-chart>
	<div class="flex shrink-0 flex-wrap items-center justify-between gap-3">
		<div class="min-w-0">
			<h2 class="text-sm font-semibold">{t('Teams')}</h2>
			<p class="text-meta">
				{t(
					'A team holds the policies its members act under. A parent scopes data and lends no policy.'
				)}
			</p>
		</div>
		<div class="flex shrink-0 items-center gap-2">
			{#if settings.teams.length > 0}
				<Button
					variant="outline"
					onclick={() => {
						layoutRevision += 1;
					}}
				>
					<Icon name="lucide:layout-grid" class="size-3.5" />{t('Auto-arrange')}
				</Button>
			{/if}
			<Button onclick={() => openCreate(null)}>
				<Icon name="lucide:plus" class="size-3.5" />{t('New team')}
			</Button>
		</div>
	</div>

	{#if error !== null}
		<p class="shrink-0 text-sm text-destructive" role="alert">{error}</p>
	{/if}

	{#if settings.teams.length === 0}
		<EmptyState
			variant="inset"
			size="fill"
			icon="user"
			title={t('No teams yet')}
			hint={t('Create teams and link parent teams to shape your organization chart.')}
		>
			<Button onclick={() => openCreate(null)}>{t('New team')}</Button>
		</EmptyState>
	{:else}
		<div
			class="teams-flow relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border bg-surface-lane"
		>
			<SvelteFlow
				bind:nodes
				bind:edges
				{nodeTypes}
				fitView
				fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
				connectionLineType={ConnectionLineType.SmoothStep}
				deleteKey={null}
				proOptions={{ hideAttribution: true }}
				onconnect={reparent}
				onnodeclick={({ node }) => openEdit(node.id)}
			>
				<Background variant={BackgroundVariant.Dots} gap={20} size={1} />
				<Controls showLock={false} />
			</SvelteFlow>
		</div>
		<p class="text-meta shrink-0">
			{t('Click a team to edit its policies, or drag from a team’s bottom handle to connect a sub-team.')}
		</p>
	{/if}
</div>

<Sheet
	open={sheetOpen}
	title={editing_team?.name ?? t('New team')}
	memory="team"
	on_open_change={(open) => {
		if (!open) closeSheet();
	}}
>
	{#if error !== null}<p class="mb-3 text-sm text-destructive" role="alert">{error}</p>{/if}
	{#if creating}
		<Form
			{ctx}
			of="sys_team"
			mode="create"
			size="content"
			submit={t('Create team')}
			values={createParent === null ? {} : { parent: createParent }}
			on_outcome={(outcome) => saved(outcome.kind)}
		>
			{@render fields(null)}
		</Form>
	{:else if editing_team !== undefined}
		{@const team = editing_team}
		<Form
			{ctx}
			of="sys_team"
			mode="update"
			id={team.id}
			size="content"
			submit={t('Save')}
			on_outcome={(outcome) => saved(outcome.kind)}
		>
			{#snippet children()}{@render fields(team.id)}{/snippet}
			{#snippet actions()}
				<Button variant="outline" onclick={() => remove(team)}>{t('Delete team')}</Button>
			{/snippet}
		</Form>
	{/if}
</Sheet>

<style>
	.teams-flow :global(.svelte-flow) {
		--xy-background-color-default: transparent;
		--xy-background-pattern-dots-color-default: var(--border);
		--xy-controls-button-background-color-default: var(--card);
		--xy-controls-button-background-color-hover-default: var(--muted);
		--xy-controls-button-color-default: var(--foreground);
		--xy-controls-button-border-color-default: var(--border);
		--xy-edge-stroke-default: var(--border);
		--xy-connectionline-stroke-default: var(--brand);
	}
	.teams-flow :global(.svelte-flow__controls) {
		box-shadow: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		overflow: hidden;
	}
</style>
