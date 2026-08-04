<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionKanban } from '@norbital-ai/ui/collection-kanban';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cover, Inline, Stack } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';

	type AccountScopeRow = {
		readonly norbital_id: string;
		readonly name: string;
		readonly active?: boolean | null;
	};

	function resolveScopedId(
		selected: string | null,
		rows: readonly AccountScopeRow[]
	): string | null {
		if (selected != null && rows.some((row) => row.norbital_id === selected)) return selected;
		const active = rows.find((row) => row.active !== false);
		return active?.norbital_id ?? rows[0]?.norbital_id ?? null;
	}

	const quoteLanes = [
		{ value: 'draft', label: 'Draft', color: 'gray' },
		{ value: 'sent', label: 'Sent', color: 'blue' },
		{ value: 'won', label: 'Won', color: 'amber' },
		{ value: 'confirmed', label: 'Confirmed', color: 'green' },
		{ value: 'lost', label: 'Lost', color: 'red' }
	];

	let accountId = $state<string | null>(null);
	let selectedOwnerId = $state('');

	const accountsQuery = client.db.accounts.findMany({
		where: { active: { eq: true } },
		orderBy: { name: 'asc' },
		limit: 5000
	});
	const accountRows = $derived((accountsQuery.current ?? []) as readonly AccountScopeRow[]);
	const accountOptions = $derived(
		accountRows.map((account) => ({
			value: account.norbital_id,
			label: account.name,
			search_term: account.name
		}))
	);
	const selectedAccountId = $derived(resolveScopedId(accountId, accountRows));
	const accountLabelsById = $derived(
		new Map(accountRows.map((account) => [account.norbital_id, account.name]))
	);

	const usersQuery = client.db.user.findMany({
		columns: { norbital_id: true, name: true },
		orderBy: { name: 'asc' }
	});

	const ownerOptions = $derived([
		{ value: '', label: 'All reps' },
		...(usersQuery.current ?? []).map((user) => ({
			value: user.norbital_id,
			label: user.name || '—'
		}))
	]);

	const userLabelsById = $derived(
		new Map((usersQuery.current ?? []).map((user) => [user.norbital_id, user.name]))
	);

	const scopedQuotesQuery = $derived(
		selectedAccountId == null
			? null
			: client.db.quotes.findMany({
					where: { account_id: { eq: selectedAccountId } },
					columns: { norbital_id: true, doc_no: true, title: true },
					orderBy: { doc_no: 'desc' },
					limit: 5000
				})
	);
	const quoteLabelsById = $derived(
		new Map(
			(scopedQuotesQuery?.current ?? []).map((quote) => [
				quote.norbital_id,
				`${quote.doc_no}: ${quote.title}`
			])
		)
	);
	const scopedQuoteIds = $derived(
		(scopedQuotesQuery?.current ?? []).map((quote) => quote.norbital_id)
	);

	const pipelineKanbanQuery = $derived(
		selectedAccountId == null
			? undefined
			: {
					where: {
						account_id: { eq: selectedAccountId },
						...(selectedOwnerId !== '' ? { owner_id: { eq: selectedOwnerId } } : {})
					}
				}
	);

	const pipelineDashboard = $derived.by(() => {
		const params: { account_id?: string; owner_id?: string } = {};
		if (selectedAccountId != null) params.account_id = selectedAccountId;
		if (selectedOwnerId !== '') params.owner_id = selectedOwnerId;
		return client.invoke.pipeline_dashboard(params);
	});

	const pipelineCards = $derived(
		new Map((pipelineDashboard.current?.cards ?? []).map((card) => [card.id, card]))
	);
</script>

<svelte:head>
	<title>Sales CRM</title>
	<meta
		name="description"
		content="Sales pipeline, quotes, accounts, contacts, product catalogue, and activities"
	/>
	<meta name="pod:icon" content="lucide:handshake" />
</svelte:head>

{#snippet accountScopeActions()}
	<label class="grid gap-1.5 text-sm">
		<span class="font-medium text-muted-foreground">Account</span>
		<Inline gap="sm">
			<Combobox
				ariaLabel="Account"
				options={accountOptions}
				value={selectedAccountId}
				onValueChange={(value) => {
					if (typeof value === 'string') {
						accountId = value;
						return;
					}
					accountId = resolveScopedId(null, accountRows);
				}}
				emptyPlaceholder="Select account…"
				searchPlaceholder="Search accounts…"
				clientConfig={{
					isLoading: accountsQuery.loading,
					error: accountsQuery.error?.message ?? null
				}}
				class="min-w-[16rem]"
			/>
		</Inline>
	</label>
{/snippet}

{#snippet pipeline()}
	<Stack gap="md">
		<label class="grid max-w-72 gap-1.5 text-sm">
			<span class="font-medium">Owner</span>
			<Combobox
				options={ownerOptions}
				bind:value={selectedOwnerId}
				emptyPlaceholder="Select a rep…"
				searchPlaceholder="Search reps…"
				clientConfig={{ isLoading: usersQuery.loading }}
			/>
		</label>
		<CollectionKanban
			{client}
			collection="quotes"
			view="pipeline"
			groupBy="status"
			lanes={quoteLanes}
			rows={2}
			query={pipelineKanbanQuery}
		>
			{#snippet Card(quote)}
				<Stack gap="xs">
					<p class="text-sm font-medium">{quote.doc_no}: {quote.title}</p>
					{#if pipelineCards.get(quote.norbital_id)?.account}
						<p class="text-xs text-muted-foreground">
							{pipelineCards.get(quote.norbital_id)?.account}
						</p>
					{/if}
					{#if quote.gross != null}
						<p class="text-xs font-medium">
							{quote.currency}
							{Number(quote.gross).toLocaleString()}
						</p>
					{/if}
				</Stack>
			{/snippet}
		</CollectionKanban>
	</Stack>
{/snippet}

{#snippet quotes()}
	{#if selectedAccountId == null}
		<p class="text-sm text-muted-foreground">Select an account to browse its quotes.</p>
	{:else}
		<CollectionTable
			{client}
			collection="quotes"
			view={`crm:quotes:${selectedAccountId}`}
			title="Quotes"
			description="Every sales document for the selected account, including lost and cancelled deals."
			query={{
				where: { account_id: { eq: selectedAccountId } },
				orderBy: { doc_no: 'desc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column name="doc_no" label="Doc #" minWidth={140} card="badge" />
				<Column name="title" minWidth={240} card="title" />
				<Column name="status" card="badge" />
				<Column name="gross" label="Amount" />
				<Column name="currency" />
				<Column name="valid_until" label="Valid until" />
				<Column name="confirmed_at" label="Confirmed" />
				<Column
					name="owner_id"
					label="Owner"
					render={({ value }) =>
						value == null || value === '' ? '—' : (userLabelsById.get(String(value)) ?? '—')}
				/>
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet quoteLines()}
	{#if selectedAccountId == null}
		<p class="text-sm text-muted-foreground">Select an account to browse its quote lines.</p>
	{:else if scopedQuoteIds.length === 0}
		<p class="text-sm text-muted-foreground">No quotes exist for this account yet.</p>
	{:else}
		<CollectionTable
			{client}
			collection="quote_lines"
			view={`crm:quote-lines:${selectedAccountId}`}
			title="Quote lines"
			description="Line items for quotes on the selected account."
			query={{
				where: { quote_id: { in: scopedQuoteIds } },
				orderBy: { quote_id: 'desc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column
					name="quote_id"
					label="Quote"
					minWidth={200}
					card="title"
					render={({ value }) =>
						value == null || value === '' ? '—' : (quoteLabelsById.get(String(value)) ?? '—')}
				/>
				<Column name="product_code" label="Code" minWidth={100} />
				<Column name="product_name" label="Product" minWidth={200} />
				<Column name="quantity" />
				<Column name="unit_price" label="Unit price" />
				<Column name="discount_pct" label="Discount %" />
				<Column name="line_total" label="Total" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet accounts()}
	<CollectionTable
		{client}
		collection="accounts"
		title="Accounts"
		description="Companies and organizations in your pipeline."
		query={{ where: { active: { eq: true } }, orderBy: { name: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="name" minWidth={240} card="title" />
			<Column name="industry" minWidth={160} card="subtitle" />
			<Column name="phone" minWidth={140} />
			<Column name="currency" card="badge" />
			<Column name="active" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet contacts()}
	{#if selectedAccountId == null}
		<p class="text-sm text-muted-foreground">Select an account to browse its contacts.</p>
	{:else}
		<CollectionTable
			{client}
			collection="contacts"
			view={`crm:contacts:${selectedAccountId}`}
			title="Contacts"
			description="People at the selected account — decision-makers and day-to-day contacts."
			query={{
				where: { account_id: { eq: selectedAccountId }, active: { eq: true } },
				orderBy: { first_name: 'asc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column name="first_name" label="First name" card="title" />
				<Column name="last_name" label="Last name" card="subtitle" />
				<Column name="email" minWidth={200} />
				<Column name="title" />
				<Column name="department" />
				<Column name="active" />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet products()}
	<CollectionTable
		{client}
		collection="products"
		title="Products"
		description="Sellable catalogue. Quote lines snapshot from here at creation."
		query={{ where: { active: { eq: true } }, orderBy: { name: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="code" minWidth={120} card="badge" />
			<Column name="name" minWidth={240} card="title" />
			<Column name="unit" />
			<Column name="unit_price" label="Unit price" />
			<Column name="active" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet activities()}
	{#if selectedAccountId == null}
		<p class="text-sm text-muted-foreground">Select an account to browse related activities.</p>
	{:else}
		<CollectionTable
			{client}
			collection="activities"
			view={`crm:activities:${selectedAccountId}`}
			title="Activities"
			description="Calls, meetings, emails, tasks, and notes linked to the selected account or its quotes."
			query={{
				where: {
					or: [
						{
							regarding_type: { eq: 'accounts' },
							regarding_id: { eq: selectedAccountId }
						},
						...(scopedQuoteIds.length > 0
							? [
									{
										regarding_type: { eq: 'quotes' as const },
										regarding_id: { in: scopedQuoteIds }
									}
								]
							: [])
					]
				},
				orderBy: { due_date: 'desc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column name="subject" minWidth={280} card="title" />
				<Column name="type" card="badge" />
				<Column
					name="regarding_id"
					label="Regarding"
					minWidth={200}
					render={({ row, value }) => {
						const map = row.regarding_type === 'accounts' ? accountLabelsById : quoteLabelsById;
						return value == null || value === '' ? '—' : (map.get(String(value)) ?? '—');
					}}
				/>
				<Column name="due_date" label="Due" />
				<Column name="completed_at" label="Completed" />
				<Column
					name="owner_id"
					label="Owner"
					render={({ value }) =>
						value == null || value === '' ? '—' : (userLabelsById.get(String(value)) ?? '—')}
				/>
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="CRM"
		title="Sales workspace"
		description="Manage the pipeline, quotes, accounts, contacts, catalogue, and team activities."
		actions={accountScopeActions}
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Tabs
		animate={false}
		config={[
			{ name: 'pipeline', label: 'Pipeline', icon: 'lucide:kanban', content: pipeline },
			{ name: 'quotes', label: 'Quotes', icon: 'lucide:file-text', content: quotes },
			{
				name: 'quote-lines',
				label: 'Quote lines',
				icon: 'lucide:list-checks',
				content: quoteLines
			},
			{ name: 'accounts', label: 'Accounts', icon: 'lucide:building-2', content: accounts },
			{ name: 'contacts', label: 'Contacts', icon: 'lucide:contact-round', content: contacts },
			{ name: 'products', label: 'Products', icon: 'lucide:package', content: products },
			{
				name: 'activities',
				label: 'Activities',
				icon: 'lucide:calendar-check',
				content: activities
			}
		] satisfies TabConfig[]}
	/>
</Cover>
