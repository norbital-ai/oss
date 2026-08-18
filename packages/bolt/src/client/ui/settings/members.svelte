<script lang="ts">
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cluster, Inline, Stack } from '@norbital-ai/ui/layout';
	import { memberLabel, sortMembers, type MemberRole, type MemberRow } from './rows.js';

	let {
		members = [],
		busy = false,
		onRoleChange
	}: {
		members?: ReadonlyArray<MemberRow>;
		busy?: boolean;
		onRoleChange?: (memberId: string, role: MemberRole) => void;
	} = $props();

	// Combobox takes a mutable option list; a readonly array is not assignable to it.
	const ROLES: Array<{ value: MemberRole; label: string }> = [
		{ value: 'admin', label: 'Admin' },
		{ value: 'manager', label: 'Manager' },
		{ value: 'basic', label: 'Basic' }
	];
	const ordered = $derived(sortMembers(members));
</script>

<Stack as="section" gap="md" aria-busy={busy}>
	<Stack as="header" gap="xs">
		<h2 class="text-lg font-semibold">Members</h2>
		<p class="text-sm text-muted-foreground">
			Everyone who holds a seat in this workspace, and the role each one carries.
		</p>
	</Stack>
	{#if busy && ordered.length === 0}
		<!-- "Loading" and "none" are different statements, and this said the second while the first was
		     true: `busy` reached only `aria-busy`, so a surface waiting on its first read rendered
		     "No members found." to somebody whose workspace was full of them. -->
		<p role="status" class="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
			Loading members…
		</p>
	{:else if ordered.length === 0}
		<div class="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
			No members found.
		</div>
	{:else}
		<Stack as="ul" gap="md" aria-label="Members" class="m-0 list-none p-0">
			{#each ordered as member (member.id)}
				<Cluster
					as="li"
					gap="md"
					align="start"
					justify="between"
					class="rounded-lg border bg-card p-4"
				>
					<Stack gap="xs">
						<h3 class="font-medium" data-testid="member-name">{memberLabel(member)}</h3>
						<p class="text-xs text-muted-foreground">{member.email}</p>
					</Stack>
					<Inline gap="sm" shrink={false}>
						{#if member.status !== 'active'}
							<span
								class="rounded-full border px-2 py-0.5 text-xs text-muted-foreground"
								data-testid="member-status">{member.status}</span
							>
						{/if}
						<!-- A Combobox, not a native select: every other enum in the product uses one, and a
						     bare select renders the operating system's own menu, ignoring the theme. -->
						<Combobox
							options={ROLES}
							value={member.role}
							disabled={busy || onRoleChange === undefined}
							onValueChange={(role) => {
							// The Combobox reports the chosen value as an open string. Looking it back up in
							// the list that defines the legal set proves it is a role, where `as MemberRole`
							// only asserted it — and the list is already the single source of that set.
							const chosen = ROLES.find((option) => option.value === role);
							if (chosen !== undefined) onRoleChange?.(member.id, chosen.value);
						}}
						/>
					</Inline>
				</Cluster>
			{/each}
		</Stack>
	{/if}
</Stack>
