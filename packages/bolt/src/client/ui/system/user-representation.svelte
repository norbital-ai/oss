<script lang="ts">
	import { Effect, Schema } from 'effect';
	import Icon from '@iconify/svelte';
	import { getErrorMessage } from '@norbital-ai/std';
	import { Button } from '@norbital-ai/ui/button';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Grid, Inline, Stack } from '@norbital-ai/ui/layout';
	import { readMembershipEditor } from './membership-editor.svelte.js';

	let { record }: { record: Record<string, unknown> | null; close?: () => void } = $props();
	const isString = Schema.is(Schema.String);
	const text = (name: string): string | undefined => {
		const value = record?.[name];
		return isString(value) && value.trim() !== '' ? value : undefined;
	};
	const name = $derived(text('name') ?? text('email') ?? 'Workspace member');
	const initials = $derived(
		name
			.split(/\s+/u)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase())
			.join('') || '?'
	);
	const readEditor = readMembershipEditor();
	const editor = $derived(readEditor());
	const canManage = $derived(editor?.canManage === true);
	const memberId = $derived(text('id') ?? '');
	const recordedRole = $derived(text('role') === 'admin' ? 'admin' : 'basic');
	const recordedTeamId = $derived.by(() => {
		const teamName = text('team');
		if (teamName === undefined || editor === null) return null;
		return editor.teams.find((team) => team.name === teamName)?.id ?? null;
	});
	// repository-health:allow V18 -- Svelte 5 writable derived: the draft follows the recorded value until the user edits it, then overrides it and resets when the record next changes; $state would never reset and an edit-object would leak across member switches.
	let draftRole = $derived(recordedRole);
	let draftTeamId = $derived(recordedTeamId); // repository-health:allow V18 -- same writable-derived draft contract as draftRole above.
	let pending = $state(false);
	let saveFailure = $state<string | null>(null);
	const dirty = $derived(draftRole !== recordedRole || draftTeamId !== recordedTeamId);
	const roleOptions = [
		{ value: 'admin', label: 'Admin' },
		{ value: 'basic', label: 'Basic' }
	] as const;
	const teamOptions = $derived(
		(editor?.teams ?? []).map((team) => ({ value: team.id, label: team.name }))
	);
	const teamLabel = $derived(
		editor?.teams.find((team) => team.id === recordedTeamId)?.name ??
			text('team') ??
			text('team_name') ??
			text('team_id')
	);

	function saveMembership(): void {
		const membership = editor;
		const id = memberId;
		if (membership === null || id.length === 0 || pending || !dirty) return;
		const nextRole = draftRole;
		const nextTeamId = draftTeamId;
		const roleChanged = nextRole !== recordedRole;
		const teamChanged = nextTeamId !== recordedTeamId;
		pending = true;
		saveFailure = null;
		Effect.runFork(
			Effect.gen(function* () {
				if (roleChanged) yield* membership.setMemberAdmin(id, nextRole === 'admin');
				if (teamChanged) yield* membership.assignTeam(id, nextTeamId);
			}).pipe(
				Effect.match({
					onSuccess: () => {
						pending = false;
						membership.refresh();
					},
					onFailure: (error) => {
						pending = false;
						saveFailure = getErrorMessage(error);
					}
				})
			)
		);
	}
</script>

<Stack gap="lg" class="p-5">
	<Inline gap="md" align="center">
		<div
			class="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand/10 text-sm font-bold text-brand"
		>
			{initials}
		</div>
		<Stack gap="xs" class="min-w-0">
			<p class="truncate text-base font-semibold text-foreground">{name}</p>
			<p class="truncate text-sm text-muted-foreground">{text('email') ?? 'No email recorded'}</p>
		</Stack>
	</Inline>

	<Stack gap="sm">
		<h3 class="text-sm font-semibold text-foreground">Access and membership</h3>
		{#if canManage}
			<Stack gap="md">
				<label class="text-sm font-medium">
					<Stack gap="xs">
						<span>Role</span>
						<Combobox
							options={[...roleOptions]}
							value={draftRole}
							onValueChange={(next) => {
								if (next === 'admin' || next === 'basic') draftRole = next;
							}}
							allowClear={false}
							ariaLabel="Role"
							searchPlaceholder="Search roles…"
							emptyPlaceholder="No matching role"
						/>
					</Stack>
				</label>
				<label class="text-sm font-medium">
					<Stack gap="xs">
						<span>Team</span>
						<Combobox
							options={teamOptions}
							value={draftTeamId}
							onValueChange={(next) => {
								draftTeamId = typeof next === 'string' ? next : null;
							}}
							allowClear={true}
							ariaLabel="Team"
							searchPlaceholder="Search teams…"
							emptyPlaceholder="No matching team"
						/>
					</Stack>
				</label>
				<Grid as="dl" gap="md" tracks="minmax(7rem,auto) minmax(0,1fr)" class="text-sm">
					<dt class="text-muted-foreground">
						<Inline align="center" gap="sm">
							<Icon icon="lucide:circle-dot" class="size-4" /> Status
						</Inline>
					</dt>
					<dd class="capitalize text-foreground">{text('status') ?? 'Active'}</dd>
				</Grid>
				{#if saveFailure !== null}
					<p class="text-sm text-destructive" role="alert">{saveFailure}</p>
				{/if}
				<Inline justify="end">
					<Button type="button" size="sm" disabled={pending || !dirty} onclick={saveMembership}>
						{pending ? 'Saving…' : 'Save'}
					</Button>
				</Inline>
			</Stack>
		{:else}
			<Grid as="dl" gap="md" tracks="minmax(7rem,auto) minmax(0,1fr)" class="text-sm">
				<dt class="text-muted-foreground">
					<Inline align="center" gap="sm">
						<Icon icon="lucide:shield-check" class="size-4" /> Role
					</Inline>
				</dt>
				<dd class="capitalize text-foreground">{text('role') ?? text('access') ?? 'Member'}</dd>
				<dt class="text-muted-foreground">
					<Inline align="center" gap="sm">
						<Icon icon="lucide:circle-dot" class="size-4" /> Status
					</Inline>
				</dt>
				<dd class="capitalize text-foreground">{text('status') ?? 'Active'}</dd>
				<dt class="text-muted-foreground">
					<Inline align="center" gap="sm">
						<Icon icon="lucide:users" class="size-4" /> Team
					</Inline>
				</dt>
				<dd class="text-foreground">{teamLabel ?? 'Not assigned'}</dd>
			</Grid>
		{/if}
	</Stack>

	<Stack gap="xs" class="rounded-lg border bg-muted/30 p-4">
		<p class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Identity</p>
		<p class="break-all font-mono text-xs text-foreground">{text('id') ?? 'No identifier'}</p>
	</Stack>
</Stack>
