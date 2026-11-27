<!--
	Platform-native listening scope editor shared by conversation connections (`sys_integration.listen`) and
	envoy channel bindings (`sys_envoy_channel.scope`). Lets operators scope DMs/senders (off / selected teams,
	members, or handles / all) and groups/channels (off / selected discovered or observed threads / all), with
	conflict badges when multiple envoys share one channel.
-->
<script lang="ts">
	import { Effect } from 'effect';
	import { observe_once } from '@norbital-ai/ui/effect';
	import { Badge, Button, Checkbox, Combobox, Icon, Input, Spinner } from '@norbital-ai/ui';
	import { Cluster, Inline, Stack } from '@norbital-ai/ui/layout';
	import type { IntegrationClient } from '../../page/integrations.ts';
	import {
		normalizeListeningScope,
		type DmScope,
		type GroupEntry,
		type GroupScope,
		type ListeningScope
	} from '../../engine/integrations/scope.ts';

	type Mode = 'all' | 'selected' | 'off';
	type GroupTrigger = 'disabled' | 'mention_or_reply' | 'all' | null;

	let {
		driver,
		instance,
		client,
		value,
		on_change,
		teams = [],
		members = [],
		audience,
		group_messages,
		on_group_messages_change,
		claimed_groups,
		claimed_all_groups_by = [],
		claimed_all_dms_by = [],
		disabled = false,
		t
	}: {
		driver: string;
		instance: string;
		client: IntegrationClient;
		value: ListeningScope | null;
		on_change: (next: ListeningScope | null) => void;
		teams?: readonly { readonly id: string; readonly name: string }[];
		members?: readonly {
			readonly id: string;
			readonly name: string | null;
			readonly email: string | null;
			readonly phone: string | null;
		}[];
		audience?: 'private' | 'public' | undefined;
		group_messages?: GroupTrigger | undefined;
		on_group_messages_change?: ((next: GroupTrigger) => void) | undefined;
		/** Map of group thread id → other envoy names claiming that group on the same shared channel. */
		claimed_groups?: ReadonlyMap<string, readonly string[]> | undefined;
		claimed_all_groups_by?: readonly string[] | undefined;
		claimed_all_dms_by?: readonly string[] | undefined;
		disabled?: boolean;
		t: (key: string) => string;
	} = $props();

	const isEmail = $derived(driver === 'email');
	const dmMode = $derived<Mode>(value?.dm?.mode ?? 'all');
	const groupMode = $derived<Mode>(value?.groups?.mode ?? 'all');
	const selectedTeams = $derived<readonly string[]>(value?.dm?.teams ?? []);
	const selectedMembers = $derived<readonly string[]>(value?.dm?.members ?? []);
	const selectedHandles = $derived<readonly string[]>(value?.dm?.handles ?? []);
	const selectedGroups = $derived<readonly GroupEntry[]>(value?.groups?.threads ?? []);
	const selectedGroupIds = $derived(new Set(selectedGroups.map((g) => g.id)));

	const emptyThreads: {
		readonly groups: readonly { readonly id: string; readonly label: string; readonly last_at?: string }[];
		readonly dms: readonly { readonly id: string; readonly handle: string; readonly label: string; readonly last_at?: string }[];
	} = { groups: [], dms: [] };
	const threads = observe_once(() => {
		const id = instance;
		return id === ''
			? null
			: client.threads().pipe(Effect.catch(() => Effect.succeed(emptyThreads)));
	});

	let handleDraft = $state('');
	let groupSearch = $state('');
	let manualGroupId = $state('');

	const emit = (dm: DmScope, groups: GroupScope) => {
		on_change(normalizeListeningScope({ dm, groups }));
	};

	const currentDm = (): DmScope => ({
		mode: dmMode,
		...(selectedTeams.length > 0 ? { teams: [...selectedTeams] } : {}),
		...(selectedMembers.length > 0 ? { members: [...selectedMembers] } : {}),
		...(selectedHandles.length > 0 ? { handles: [...selectedHandles] } : {})
	});

	const currentGroups = (): GroupScope => ({
		mode: groupMode,
		...(selectedGroups.length > 0 ? { threads: [...selectedGroups] } : {})
	});

	const setDmMode = (mode: Mode) => emit({ ...currentDm(), mode }, currentGroups());
	const setGroupMode = (mode: Mode) => emit(currentDm(), { ...currentGroups(), mode });

	const setTeams = (next: readonly string[]) =>
		emit({ ...currentDm(), mode: 'selected', teams: [...next] }, currentGroups());

	const setMembers = (next: readonly string[]) =>
		emit({ ...currentDm(), mode: 'selected', members: [...next] }, currentGroups());

	const addHandle = (raw: string) => {
		const trimmed = raw.trim();
		if (trimmed === '') return;
		if (selectedHandles.some((h) => h.toLowerCase() === trimmed.toLowerCase())) {
			handleDraft = '';
			return;
		}
		emit(
			{ ...currentDm(), mode: 'selected', handles: [...selectedHandles, trimmed] },
			currentGroups()
		);
		handleDraft = '';
	};

	const removeHandle = (target: string) =>
		emit(
			{
				...currentDm(),
				mode: 'selected',
				handles: selectedHandles.filter((h) => h !== target)
			},
			currentGroups()
		);

	const toggleGroup = (id: string, label?: string) => {
		if (selectedGroupIds.has(id)) {
			emit(currentDm(), {
				mode: 'selected',
				threads: selectedGroups.filter((g) => g.id !== id)
			});
		} else {
			emit(currentDm(), {
				mode: 'selected',
				threads: [
					...selectedGroups,
					label !== undefined && label.trim() !== '' ? { id, label: label.trim() } : { id }
				]
			});
		}
	};

	const addManualGroup = () => {
		const id = manualGroupId.trim();
		if (id === '') return;
		if (!selectedGroupIds.has(id)) toggleGroup(id);
		manualGroupId = '';
	};

	const allGroupChoices = $derived.by(() => {
		const map = new Map<string, { id: string; label: string }>();
		for (const g of threads.current?.groups ?? []) map.set(g.id, { id: g.id, label: g.label });
		for (const g of selectedGroups) {
			if (!map.has(g.id)) map.set(g.id, { id: g.id, label: g.label ?? g.id });
		}
		const q = groupSearch.trim().toLowerCase();
		return [...map.values()].filter(
			(g) => q === '' || g.label.toLowerCase().includes(q) || g.id.toLowerCase().includes(q)
		);
	});

	const suggestedDms = $derived(
		(threads.current?.dms ?? [])
			.filter(
				(dm) => !selectedHandles.some((h) => h.toLowerCase() === dm.handle.toLowerCase())
			)
			.slice(0, 12)
	);

	const handlePlaceholder = $derived(
		driver === 'email'
			? t('name@company.com or @company.com')
			: driver === 'whatsapp'
				? t('+65 9123 4567')
				: driver === 'telegram'
					? t('@username')
					: t('Handle or user ID')
	);

	const memberLabel = (m: (typeof members)[number]) =>
		m.name && m.name.trim() !== ''
			? m.name
			: m.email ?? m.phone ?? m.id;
</script>

{#snippet modeRail(current: Mode, onPick: (mode: Mode) => void, labels: { all: string; selected: string; off: string }, attr: string)}
	<div
		class="inline-flex rounded-md bg-surface-track p-0.5"
		role="radiogroup"
		data-scope-mode={attr}
	>
		{#each (['all', 'selected', 'off'] as const) as mode (mode)}
			{@const active = current === mode}
			<button
				type="button"
				role="radio"
				aria-checked={active}
				{disabled}
				data-scope-option={`${attr}:${mode}`}
				class="rounded-badge px-2.5 py-1 text-xs font-medium transition-colors outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 {active
					? 'bg-background text-foreground shadow-2xs ring-1 ring-border'
					: 'text-muted-foreground hover:text-foreground'}"
				onclick={() => onPick(mode)}
			>
				{labels[mode]}
			</button>
		{/each}
	</div>
{/snippet}

<Stack gap="lg" data-listening-scope>
	<!-- Direct messages / Senders -->
	<Stack gap="sm">
		<div class="flex flex-wrap items-center justify-between gap-2">
			<div class="min-w-0">
				<p class="text-sm font-medium text-foreground">
					{isEmail ? t('Senders') : t('Direct messages')}
				</p>
				<p class="text-meta">
					{isEmail
						? t('Choose which email senders or domains are handled here.')
						: audience === 'private'
							? t('Limit which workspace members or handles can DM this envoy.')
							: t('Choose which direct chats are handled here.')}
				</p>
			</div>
			{@render modeRail(
				dmMode,
				setDmMode,
				{
					all: t('All'),
					selected: t('Selected'),
					off: t('Off')
				},
				'dm'
			)}
		</div>

		{#if dmMode === 'all' && claimed_all_dms_by.length > 0}
			<p class="text-xs text-warning" role="status">
				{t('Also set to All DMs on: {names}').replace('{names}', claimed_all_dms_by.join(', '))}
			</p>
		{/if}

		{#if dmMode === 'selected'}
			<Stack gap="sm" class="rounded-control border border-border bg-surface-subtle p-3">
				{#if teams.length > 0}
					<label class="flex flex-col gap-1">
						<span class="text-label">{t('Teams')}</span>
						<Combobox
							multiple
							searchable
							{disabled}
							aria-label={t('Teams')}
							placeholder={t('Select teams')}
							options={teams.map((team) => ({ value: team.id, label: team.name }))}
							value={[...selectedTeams]}
							on_change={(next) => setTeams(Array.isArray(next) ? next : [])}
						/>
					</label>
				{/if}

				{#if members.length > 0}
					<label class="flex flex-col gap-1">
						<span class="text-label">{t('Members')}</span>
						<Combobox
							multiple
							searchable
							{disabled}
							aria-label={t('Members')}
							placeholder={t('Select members')}
							options={members.map((m) => ({
								value: m.id,
								label: memberLabel(m),
								...(m.email ? { description: m.email } : m.phone ? { description: m.phone } : {})
							}))}
							value={[...selectedMembers]}
							on_change={(next) => setMembers(Array.isArray(next) ? next : [])}
						/>
					</label>
				{/if}

				<Stack gap="xs">
					<span class="text-label">
						{isEmail ? t('Addresses & domains') : t('Handles & parties')}
					</span>
					{#if selectedHandles.length > 0}
						<Cluster gap="xs">
							{#each selectedHandles as handle (handle)}
								<span
									class="inline-flex items-center gap-1 rounded-badge border border-border bg-background px-2 py-0.5 font-mono text-xs text-foreground"
									data-scope-handle={handle}
								>
									<span>{handle}</span>
									<button
										type="button"
										{disabled}
										class="text-muted-foreground hover:text-foreground"
										aria-label={`${t('Remove')} ${handle}`}
										onclick={() => removeHandle(handle)}
									>
										<Icon name="lucide:x" class="size-3" />
									</button>
								</span>
							{/each}
						</Cluster>
					{/if}
					<div class="flex items-center gap-2">
						<Input
							class="h-8 flex-1"
							{disabled}
							placeholder={handlePlaceholder}
							bind:value={handleDraft}
							onkeydown={(event) => {
								if (event.key === 'Enter') {
									event.preventDefault();
									addHandle(handleDraft);
								}
							}}
							data-scope-handle-input
						/>
						<Button
							type="button"
							variant="outline"
							disabled={disabled || handleDraft.trim() === ''}
							onclick={() => addHandle(handleDraft)}
							data-scope-handle-add
						>
							{t('Add')}
						</Button>
					</div>
					{#if suggestedDms.length > 0}
						<Stack gap="xs" class="pt-1">
							<span class="text-micro text-muted-foreground">{t('Recent chats on this channel')}</span>
							<Cluster gap="xs">
								{#each suggestedDms as dm (dm.handle)}
									<button
										type="button"
										{disabled}
										class="inline-flex items-center gap-1 rounded-badge border border-border-control bg-background px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border-active hover:text-foreground"
										onclick={() => addHandle(dm.handle)}
									>
										<Icon name="lucide:plus" class="size-3" />
										<span class="max-w-48 truncate">{dm.label}</span>
									</button>
								{/each}
							</Cluster>
						</Stack>
					{/if}
				</Stack>
			</Stack>
		{/if}
	</Stack>

	<!-- Groups / Channels (chat drivers only) -->
	{#if !isEmail}
		<Stack gap="sm" class="border-t border-border pt-4">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<div class="min-w-0">
					<p class="text-sm font-medium text-foreground">{t('Groups')}</p>
					<p class="text-meta">
						{t('Choose which groups or channels are listened to on this connection.')}
					</p>
				</div>
				{@render modeRail(
					groupMode,
					setGroupMode,
					{
						all: t('All'),
						selected: t('Selected'),
						off: t('Off')
					},
					'groups'
				)}
			</div>

			{#if groupMode === 'all' && claimed_all_groups_by.length > 0}
				<p class="text-xs text-warning" role="status">
					{t('Also set to All groups on: {names}').replace('{names}', claimed_all_groups_by.join(', '))}
				</p>
			{/if}

			{#if groupMode === 'selected'}
				<Stack gap="sm" class="rounded-control border border-border bg-surface-subtle p-3">
					<div class="flex items-center gap-2">
						<Input
							class="h-8 flex-1"
							type="search"
							{disabled}
							placeholder={t('Filter groups…')}
							bind:value={groupSearch}
							data-scope-group-search
						/>
						<Button
							type="button"
							variant="ghost"
							disabled={disabled || threads.loading}
							onclick={() => threads.refetch()}
						>
							{#if threads.loading}
								<Spinner class="size-3.5" />
							{:else}
								<Icon name="lucide:refresh-cw" class="size-3.5" />
							{/if}
							{t('Refresh')}
						</Button>
					</div>

					{#if threads.loading && allGroupChoices.length === 0}
						<Inline gap="xs" align="center" class="py-2 text-meta">
							<Spinner class="size-3.5" /><span>{t('Loading groups…')}</span>
						</Inline>
					{:else if allGroupChoices.length === 0}
						<p class="py-1 text-meta">
							{t('No groups found yet. Pair the channel, send a message in a group, or add a group ID below.')}
						</p>
					{:else}
						<ul class="flex max-h-52 flex-col divide-y divide-border/60 overflow-auto rounded-control border border-border bg-background">
							{#each allGroupChoices as group (group.id)}
								{@const checked = selectedGroupIds.has(group.id)}
								{@const others = claimed_groups?.get(group.id) ?? []}
								<li>
									<label
										class="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-surface-hover"
										data-scope-group={group.id}
									>
										<span class="flex min-w-0 items-center gap-2.5">
											<Checkbox
												{checked}
												{disabled}
												on_checked_change={() => toggleGroup(group.id, group.label)}
											/>
											<span class="min-w-0">
												<span class="block truncate font-medium text-foreground">{group.label}</span>
												{#if group.label !== group.id}
													<span class="block truncate font-mono text-micro text-muted-foreground">{group.id}</span>
												{/if}
											</span>
										</span>
										{#if others.length > 0}
											<Badge variant="outline" class="shrink-0 text-warning">
												{t('Used by {names}').replace('{names}', others.join(', '))}
											</Badge>
										{/if}
									</label>
								</li>
							{/each}
						</ul>
					{/if}

					<div class="flex items-center gap-2 pt-1">
						<Input
							class="h-8 flex-1 font-mono text-xs"
							{disabled}
							placeholder={t('Add group ID manually…')}
							bind:value={manualGroupId}
							onkeydown={(event) => {
								if (event.key === 'Enter') {
									event.preventDefault();
									addManualGroup();
								}
							}}
							data-scope-group-manual
						/>
						<Button
							type="button"
							variant="outline"
							disabled={disabled || manualGroupId.trim() === ''}
							onclick={addManualGroup}
							data-scope-group-add
						>
							{t('Add')}
						</Button>
					</div>
				</Stack>
			{/if}

			{#if on_group_messages_change !== undefined && groupMode !== 'off'}
				<label class="flex flex-col gap-1">
					<span class="text-label">{t('Group trigger on this channel')}</span>
					<Combobox
						{disabled}
						aria-label={t('Group trigger on this channel')}
						value={group_messages ?? '__inherit__'}
						options={[
							{ value: '__inherit__', label: t('Inherit envoy default') },
							{ value: 'mention_or_reply', label: t('Mention or reply') },
							{ value: 'all', label: t('All messages') },
							{ value: 'disabled', label: t('Disabled') }
						]}
						on_change={(next) => {
							on_group_messages_change(
								next === 'mention_or_reply' || next === 'all' || next === 'disabled' ? next : null
							);
						}}
					/>
				</label>
			{/if}
		</Stack>
	{/if}
</Stack>
