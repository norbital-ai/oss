<script lang="ts">
	import type {
		CollectionClient,
		CollectionRecord,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import { UserRoleSchema } from '@norbital-ai/platform-utils/system/types';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { humanize } from '@norbital-ai/std/string';
	import { Bound, Inline, Stack } from '@norbital-ai/ui/layout';
	import { renderSnippet } from '@norbital-ai/ui/utils';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { PodUiKeys } from '$lib/i18n/index.js';

	const { t } = useI18n<PodUiKeys>();

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
	const roleOptions = roles.map((role) => ({ value: role, label: humanize(role) }));
	const text = (row: UserRow, field: string): string =>
		typeof row[field] === 'string' ? row[field] : '';
</script>

<!--
	`Combobox`, not a bare `<select>`.

	A native select renders the operating system's own menu — on macOS a blue system-highlight popup
	that matches nothing else in the product and ignores the theme entirely. Every other enum in the
	product goes through `Combobox`, including the one the collection table's own data renderer uses
	for `field.kind === 'enum'`, so this cell was the odd one out rather than the rule.
-->
{#snippet roleCell({ row }: { row: UserRow })}
	<Combobox
		options={roleOptions}
		value={text(row, 'role') || 'basic'}
		ariaLabel={t('pod.settings.roleFor', { email: text(row, 'email') })}
		searchable={false}
		disabled={busy}
		class="h-8 text-xs"
		onValueChange={(next) => {
			if (typeof next === 'string') onRoleChange(text(row, 'norbital_id'), next);
		}}
	/>
{/snippet}

{#snippet emailCell({ row }: { row: UserRow })}
	<span data-testid="member-email">{text(row, 'email')}</span>
{/snippet}

<Bound size="fit">
	<CollectionTable
		{client}
		collection="user"
		view="workspace-settings-members"
		query={{ where: { kind: 'human' }, orderBy: { email: 'asc' }, limit: 200 }}
		title={t('pod.settings.members')}
		description={t('pod.settings.membersDescription')}
		features={{ search: true, filter: true, bulk: false, create: false }}
	>
		{#snippet columns({ Column })}
			<Column name="name" label={t('pod.settings.name')} minWidth={180} card="title" />
			<Column
				name="email"
				label={t('pod.settings.email')}
				minWidth={220}
				card="subtitle"
				render={({ row }) => renderSnippet(emailCell, { row })}
			/>
			<Column name="status" label={t('pod.settings.status')} width={110} card="badge" />
			<Column
				name="role"
				label={t('pod.settings.memberRole')}
				width={130}
				render={({ row }) => renderSnippet(roleCell, { row })}
			/>
		{/snippet}
		{#snippet ListCard(row)}
			<Stack gap="sm">
				<Inline justify="between" gap="md" align="start">
					<Stack gap="none" grow class="min-w-0">
						<p class="truncate text-sm font-medium">{text(row, 'name') || text(row, 'email')}</p>
						<p class="truncate text-xs text-muted-foreground">{text(row, 'email')}</p>
					</Stack>
					{@render roleCell({ row })}
				</Inline>
			</Stack>
		{/snippet}
	</CollectionTable>
</Bound>
