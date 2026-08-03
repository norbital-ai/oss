<script lang="ts">
	import type {
		CollectionClient,
		CollectionRecord,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import { UserRoleSchema } from '@norbital-ai/platform-utils/system/types';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { renderSnippet } from '@norbital-ai/ui/utils';

	type UserRow = CollectionRecord;
	let {
		client,
		busy,
		onRoleChange
	}: {
		client: CollectionClient<ErasedCollectionRegistry>;
		busy: boolean;
		onRoleChange: (userId: string, role: string) => void;
	} = $props();
	const roles = UserRoleSchema.options;
	const text = (row: UserRow, field: string): string =>
		typeof row[field] === 'string' ? row[field] : '';
</script>

{#snippet roleCell({ row }: { row: UserRow })}
	<select
		class="h-8 rounded-md border border-input bg-background px-2 text-xs"
		aria-label={`Role for ${text(row, 'email')}`}
		disabled={busy}
		value={text(row, 'role') || 'basic'}
		onchange={(event) => onRoleChange(text(row, 'norbital_id'), event.currentTarget.value)}
	>
		{#each roles as role (role)}<option value={role}>{role}</option>{/each}
	</select>
{/snippet}

{#snippet emailCell({ row }: { row: UserRow })}
	<span data-testid="member-email">{text(row, 'email')}</span>
{/snippet}

<CollectionTable
	{client}
	collection="user"
	view="workspace-settings-members"
	query={{ where: { kind: 'human' }, orderBy: { email: 'asc' }, limit: 200 }}
	title="Members"
	description="People whose identities and tenant roles live in this workspace database."
	features={{ search: true, filter: true, bulk: false, create: false }}
	class="h-[min(42rem,calc(100dvh-14rem))] min-h-[28rem]"
>
	{#snippet columns({ Column })}
		<Column name="name" label="Name" minWidth={180} card="title" />
		<Column
			name="email"
			label="Email"
			minWidth={220}
			card="subtitle"
			render={({ row }) => renderSnippet(emailCell, { row })}
		/>
		<Column name="status" label="Status" width={110} card="badge" />
		<Column
			name="role"
			label="Role"
			width={130}
			render={({ row }) => renderSnippet(roleCell, { row })}
		/>
	{/snippet}
	{#snippet ListCard(row)}
		<Stack gap="sm">
			<Inline justify="between" gap="md">
				<div class="min-w-0">
					<p class="truncate text-sm font-medium">{text(row, 'name') || text(row, 'email')}</p>
					<p class="truncate text-xs text-muted-foreground">{text(row, 'email')}</p>
				</div>
				{@render roleCell({ row })}
			</Inline>
		</Stack>
	{/snippet}
</CollectionTable>
