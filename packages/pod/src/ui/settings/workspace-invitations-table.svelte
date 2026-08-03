<script lang="ts">
	import type {
		CollectionBaseQuery,
		CollectionClient,
		CollectionQuery,
		CollectionRecord,
		ErasedCollectionRegistry
	} from '@norbital-ai/platform-utils/collection';
	import type { TUserRole } from '@norbital-ai/platform-utils/system/types';
	import { UserRoleSchema } from '@norbital-ai/platform-utils/system/types';
	import { Button } from '@norbital-ai/ui/button';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Inline, Stack } from '@norbital-ai/ui/layout';
	import { renderSnippet } from '@norbital-ai/ui/utils';
	import type { WorkspaceInvitation } from '../shell/workspace-settings.js';

	let {
		invitations,
		loaded,
		busy,
		mintedLink,
		onInvite,
		onRevoke,
		onRefresh
	}: {
		invitations: readonly WorkspaceInvitation[];
		loaded: boolean;
		busy: boolean;
		mintedLink: { email: string; acceptUrl: string } | null;
		onInvite: (email: string, role: TUserRole) => void;
		onRevoke: (invitationId: string) => void;
		onRefresh: () => Promise<void>;
	} = $props();
	let email = $state('');
	let role = $state<TUserRole>('basic');

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		const value = email.trim();
		if (!value) return;
		onInvite(value, role);
		email = '';
	}

	function projected(query?: CollectionBaseQuery<WorkspaceInvitation>): WorkspaceInvitation[] {
		let rows = [...invitations];
		if (query?.search) {
			const needle = query.search.toLocaleLowerCase();
			rows = rows.filter((invitation) =>
				[invitation.email, invitation.role, invitation.status].some((value) =>
					value.toLocaleLowerCase().includes(needle)
				)
			);
		}
		for (const [field, value] of Object.entries(query?.where ?? {})) {
			rows = rows.filter((invitation) => Reflect.get(invitation, field) === value);
		}
		const [order] = Object.entries(query?.orderBy ?? {});
		if (order) {
			const [field, direction] = order;
			rows.sort((left, right) => {
				const comparison = String(Reflect.get(left, field) ?? '').localeCompare(
					String(Reflect.get(right, field) ?? '')
				);
				return direction === 'desc' ? -comparison : comparison;
			});
		}
		return rows;
	}

	/**
	 * CollectionTable's data source is a deliberately safe projection rather than `db.invitation`.
	 * The real collection is client-opaque because it contains `token_hash`; this adapter exposes
	 * only the server-returned administrator view while retaining the shared table interaction model.
	 */
	const invitationClient = {
		collections: {
			invitation: {
				name: 'invitation',
				recordLabel: 'email',
				system: true,
				fields: [
					{ name: 'norbital_id', kind: 'uuid', nullable: false },
					{ name: 'email', kind: 'text', nullable: false, label: 'Email' },
					{ name: 'role', kind: 'text', nullable: false, label: 'Role' },
					{ name: 'status', kind: 'text', nullable: false, label: 'Status' },
					{ name: 'created_at', kind: 'timestamptz', nullable: false, label: 'Invited' },
					{ name: 'expires_at', kind: 'timestamptz', nullable: false, label: 'Expires' }
				]
			}
		},
		db: {
			invitation: {
				findMany(query?: CollectionQuery<WorkspaceInvitation>) {
					const offset = Number.parseInt(query?.after ?? '0', 10) || 0;
					const limit = query?.limit ?? 25;
					return {
						get current() {
							return projected(query).slice(offset, offset + limit);
						},
						get nextCursor() {
							return projected(query).length > offset + limit ? String(offset + limit) : null;
						},
						get loading() {
							return !loaded;
						},
						error: undefined,
						refresh: onRefresh
					};
				},
				count(query?: CollectionBaseQuery<WorkspaceInvitation>) {
					return {
						get current() {
							return projected(query).length;
						},
						get loading() {
							return !loaded;
						},
						error: undefined,
						refresh: onRefresh
					};
				}
			}
		},
		records: {}
	} as unknown as CollectionClient<ErasedCollectionRegistry>; // Boundary adapter: only CollectionTable's read operations are exposed.

	function date(value: string): string {
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString();
	}
</script>

{#snippet revokeCell({ row }: { row: CollectionRecord })}
	{#if row.status === 'pending'}
		<Button
			type="button"
			variant="ghost"
			size="sm"
			disabled={busy}
			onclick={() => onRevoke(String(row.norbital_id))}>Revoke</Button
		>
	{/if}
{/snippet}

{#snippet emailCell({ row }: { row: CollectionRecord })}
	<span data-testid="invitation-email">{String(row.email)}</span>
{/snippet}

<Stack gap="md" data-testid="settings-invitations">
	<Inline as="form" gap="sm" onsubmit={submit} class="rounded-lg border bg-card p-3">
		<input
			class="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-xs"
			type="email"
			placeholder="person@example.com"
			aria-label="Invitation email"
			bind:value={email}
			required
		/>
		<select
			class="h-9 rounded-md border border-input bg-background px-2 text-xs"
			aria-label="Invitation role"
			value={role}
			onchange={(event) => {
				const parsed = UserRoleSchema.safeParse(event.currentTarget.value);
				if (parsed.success) role = parsed.data;
			}}
		>
			{#each UserRoleSchema.options as option (option)}<option value={option}>{option}</option
				>{/each}
		</select>
		<Button type="submit" disabled={busy}>Invite</Button>
	</Inline>

	{#if mintedLink}
		<p
			class="rounded-md border bg-muted/40 px-3 py-2 text-tiny break-all"
			data-testid="minted-invitation"
		>
			Send this link to {mintedLink.email}: {mintedLink.acceptUrl}
		</p>
	{/if}

	<CollectionTable
		client={invitationClient}
		collection="invitation"
		view="workspace-settings-invitations"
		query={{ orderBy: { created_at: 'desc' }, limit: 25 }}
		title="Invitations"
		description="Pending and completed invitations from the tenant identity service."
		features={{ search: true, filter: false, bulk: false, create: false }}
		class="h-[min(36rem,calc(100dvh-20rem))] min-h-[24rem]"
	>
		{#snippet columns({ Column })}
			<Column
				name="email"
				label="Email"
				minWidth={220}
				card="title"
				render={({ row }) => renderSnippet(emailCell, { row })}
			/>
			<Column name="role" label="Role" width={110} card="subtitle" />
			<Column name="status" label="Status" width={110} card="badge" />
			<Column
				name="created_at"
				label="Invited"
				minWidth={180}
				render={({ row }) => date(String(row.created_at))}
			/>
			<Column
				name="expires_at"
				label="Expires"
				minWidth={180}
				render={({ row }) => date(String(row.expires_at))}
			/>
			<Column
				name="norbital_id"
				label=""
				width={90}
				render={({ row }) => renderSnippet(revokeCell, { row })}
			/>
		{/snippet}
	</CollectionTable>
	<p class="text-micro text-muted-foreground">
		Invitation secrets are excluded from live sync; CollectionTable receives only this
		server-projected safe view.
	</p>
</Stack>
