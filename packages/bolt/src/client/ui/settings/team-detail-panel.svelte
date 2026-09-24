<script lang="ts">
	import { Effect } from 'effect';
	import Icon from '@iconify/svelte';
	import { getErrorMessage } from '@norbital-ai/std';
	import { Button } from '@norbital-ai/ui/button';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Input } from '@norbital-ai/ui/input';
	import { Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { Textarea } from '@norbital-ai/ui/textarea';
	import type { MembershipEditor } from '#lib/client/ui/system/membership-editor.svelte.js';
	import { subtreeIds, type TeamNode } from '#lib/client/ui/settings/team-hierarchy.js';
	import { memberLabel, type MemberRow } from '#lib/client/ui/settings/rows.js';

	/**
	 * The expanded team: rename and describe it, move it in the tree, and change who is in it.
	 *
	 * Rendered under `{#key team.id}` so switching teams starts from that team's values. Every write
	 * calls `onChanged` on success, which refetches the workspace-access projection the whole chart
	 * reads — so the node, the edges and the member preview all reflect the write.
	 */
	let {
		team,
		teams,
		members,
		editor,
		onChanged,
		onClose
	}: {
		team: TeamNode;
		teams: ReadonlyArray<TeamNode>;
		members: ReadonlyArray<MemberRow>;
		editor: MembershipEditor;
		onChanged: () => void;
		onClose: () => void;
	} = $props();

	let name = $derived(team.name);
	let description = $derived(team.description ?? '');
	let parentId = $derived<string | null>(team.parentId ?? null);
	let pending = $state(false);
	let failure = $state<string | null>(null);

	const currentMembers = $derived(
		members
			.filter((member) => member.team === team.name)
			.sort((left, right) => memberLabel(left).localeCompare(memberLabel(right)))
	);
	const assignableMembers = $derived(
		members
			.filter((member) => member.team !== team.name)
			.sort((left, right) => memberLabel(left).localeCompare(memberLabel(right)))
	);
	/** Naming a team inside its own subtree would make a cycle, so those are not offered. */
	const forbidden = $derived(subtreeIds(teams, team.id));
	const parentOptions = $derived([
		{ value: '', label: 'No parent (top level)' },
		...teams
			.filter((candidate) => !forbidden.has(candidate.id))
			.map((candidate) => ({ value: candidate.id, label: candidate.name }))
	]);
	const memberOptions = $derived(
		assignableMembers.map((member) => ({ value: member.id, label: memberLabel(member) }))
	);
	const dirty = $derived(
		name.trim() !== team.name ||
			(description.trim() || undefined) !== team.description ||
			(parentId ?? null) !== (team.parentId ?? null)
	);

	const perform = (effect: Effect.Effect<unknown, Error>, done?: () => void): void => {
		pending = true;
		failure = null;
		Effect.runFork(
			effect.pipe(
				Effect.match({
					onSuccess: () => {
						pending = false;
						onChanged();
						done?.();
					},
					onFailure: (cause) => {
						pending = false;
						failure = getErrorMessage(cause);
					}
				})
			)
		);
	};

	const save = (): void => {
		if (!dirty || name.trim() === '') return;
		perform(
			editor.updateTeam(team.id, {
				name: name.trim(),
				parentId,
				description: description.trim() === '' ? null : description.trim()
			})
		);
	};
	const remove = (): void => {
		perform(editor.deleteTeam(team.id), onClose);
	};
	const removeMember = (memberId: string): void => {
		perform(editor.assignTeam(memberId, null));
	};
</script>

<Scroll
	name="Team details"
	layout="stack"
	gap="md"
	shrink={false}
	class="w-80 rounded-lg border border-border bg-card p-4"
>
	<Inline align="start" justify="between" gap="sm">
		<h3 class="text-sm font-semibold text-foreground">Team details</h3>
		<Button variant="ghost" size="icon" aria-label="Close details" onclick={onClose}>
			<Icon icon="lucide:x" class="size-4" />
		</Button>
	</Inline>

	<div class="text-xs text-muted-foreground">{team.id}</div>

	<Stack gap="sm">
		<label class="text-sm font-medium" for="team-name">Name</label>
		<Input
			id="team-name"
			value={name}
			oninput={(event) => (name = event.currentTarget.value)}
			placeholder="Team name"
		/>
	</Stack>

	<Stack gap="sm">
		<label class="text-sm font-medium" for="team-description">Description</label>
		<Textarea
			id="team-description"
			value={description}
			oninput={(event) => (description = event.currentTarget.value)}
			placeholder="What this team is for."
			rows={2}
		/>
	</Stack>

	<Stack gap="sm">
		<span class="text-sm font-medium">Parent team</span>
		<Combobox
			options={parentOptions}
			value={parentId ?? ''}
			onValueChange={(next) => {
				parentId = typeof next === 'string' && next !== '' ? next : null;
			}}
			allowClear={false}
			ariaLabel="Parent team"
			searchPlaceholder="Search teams…"
			emptyPlaceholder="No matching team"
		/>
	</Stack>

	<Button size="sm" disabled={pending || !dirty || name.trim() === ''} onclick={save}>
		{pending ? 'Saving…' : 'Save details'}
	</Button>

	<Stack gap="sm" class="border-t border-border pt-3">
		<h4 class="text-sm font-semibold text-foreground">Members ({currentMembers.length})</h4>
		{#if currentMembers.length === 0}
			<p class="text-xs text-muted-foreground">Nobody is in this team yet.</p>
		{:else}
			<Stack as="ul" gap="xs">
				{#each currentMembers as member (member.id)}
					<Inline as="li" justify="between" gap="sm" class="rounded-md bg-muted/40 px-2 py-1">
						<span class="min-w-0 truncate text-xs text-foreground">{memberLabel(member)}</span>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Remove {memberLabel(member)} from this team"
							disabled={pending}
							onclick={() => removeMember(member.id)}
						>
							<Icon icon="lucide:x" class="size-3.5" />
						</Button>
					</Inline>
				{/each}
			</Stack>
		{/if}
		{#if memberOptions.length > 0}
			<div>
				<Combobox
					options={memberOptions}
					value={null}
					onValueChange={(next) => {
						if (typeof next === 'string') perform(editor.assignTeam(next, team.id));
					}}
					allowClear={true}
					ariaLabel="Add a member"
					searchPlaceholder="Search members…"
					emptyPlaceholder="No matching member"
				/>
			</div>
		{/if}
	</Stack>

	{#if failure !== null}
		<p class="text-xs text-destructive" role="alert">{failure}</p>
	{/if}

	<div class="border-t border-border pt-3">
		<Button variant="outline" size="sm" disabled={pending} onclick={remove}>Delete team</Button>
		<p class="mt-1 text-xs text-muted-foreground">
			Deleting is refused while the team still has members.
		</p>
	</div>
</Scroll>
