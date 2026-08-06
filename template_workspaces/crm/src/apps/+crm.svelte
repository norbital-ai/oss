<script lang="ts">
	import { client } from '$pod/client';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
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

	const { t } = useI18n<TenantI18nKeys>();

	const quoteLanes = $derived([
		{ value: 'draft', label: t('component.status_draft'), color: 'gray' },
		{ value: 'sent', label: t('component.status_sent'), color: 'blue' },
		{ value: 'won', label: t('component.status_won'), color: 'amber' },
		{ value: 'confirmed', label: t('component.status_confirmed'), color: 'green' },
		{ value: 'lost', label: t('component.status_lost'), color: 'red' }
	]);

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
		{ value: '', label: t('app.crm.all_reps') },
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

	const scopedInvoicesQuery = $derived(
		selectedAccountId == null
			? null
			: client.db.sales_invoices.findMany({
					where: { account_id: { eq: selectedAccountId } },
					columns: { norbital_id: true, doc_no: true },
					orderBy: { doc_no: 'desc' },
					limit: 5000
				})
	);
	const invoiceLabelsById = $derived(
		new Map(
			(scopedInvoicesQuery?.current ?? []).map((invoice) => [invoice.norbital_id, invoice.doc_no])
		)
	);
	const scopedInvoiceIds = $derived(
		(scopedInvoicesQuery?.current ?? []).map((invoice) => invoice.norbital_id)
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
	<meta name="pod:thumbnail" content="/api/template-seed-assets/crm/app-media/crm-banner.svg" />
	<meta name="pod:banner" content="/api/template-seed-assets/crm/app-media/crm-banner.svg" />
</svelte:head>

{#snippet accountScopeActions()}
	<label class="grid gap-1.5 text-sm">
		<span class="font-medium text-muted-foreground">{t('app.crm.account_filter')}</span>
		<Inline gap="sm">
			<Combobox
				ariaLabel={t('app.crm.account_filter')}
				options={accountOptions}
				value={selectedAccountId}
				onValueChange={(value) => {
					if (typeof value === 'string') {
						accountId = value;
						return;
					}
					accountId = resolveScopedId(null, accountRows);
				}}
				emptyPlaceholder={t('app.crm.select_account')}
				searchPlaceholder={t('app.crm.search_accounts')}
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
			<span class="font-medium">{t('component.owner')}</span>
			<Combobox
				options={ownerOptions}
				bind:value={selectedOwnerId}
				emptyPlaceholder={t('app.crm.select_rep')}
				searchPlaceholder={t('app.crm.search_reps')}
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
		<p class="text-sm text-muted-foreground">{t('app.crm.empty_quotes')}</p>
	{:else}
		<CollectionTable
			{client}
			collection="quotes"
			view={`crm:quotes:${selectedAccountId}`}
			title={t('app.crm.tab_quotes')}
			description={t('app.crm.quotes_description')}
			query={{
				where: { account_id: { eq: selectedAccountId } },
				orderBy: { doc_no: 'desc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column name="doc_no" label={t('component.doc_no')} minWidth={140} card="badge" />
				<Column name="title" minWidth={240} card="title" />
				<Column name="status" card="badge" />
				<Column name="gross" label={t('component.amount')} />
				<Column name="currency" />
				<Column name="valid_until" label={t('component.valid_until')} />
				<Column name="confirmed_at" label={t('component.confirmed')} />
				<Column
					name="owner_id"
					label={t('component.owner')}
					render={({ value }) =>
						value == null || value === '' ? '—' : (userLabelsById.get(String(value)) ?? '—')}
				/>
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet quoteLines()}
	{#if selectedAccountId == null}
		<p class="text-sm text-muted-foreground">{t('app.crm.empty_quote_lines')}</p>
	{:else if scopedQuoteIds.length === 0}
		<p class="text-sm text-muted-foreground">{t('app.crm.no_quote_lines')}</p>
	{:else}
		<CollectionTable
			{client}
			collection="quote_lines"
			view={`crm:quote-lines:${selectedAccountId}`}
			title={t('app.crm.tab_quote_lines')}
			description={t('app.crm.quote_lines_description')}
			query={{
				where: { quote_id: { in: scopedQuoteIds } },
				orderBy: { quote_id: 'desc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column
					name="quote_id"
					label={t('component.quote')}
					minWidth={200}
					card="title"
					render={({ value }) =>
						value == null || value === '' ? '—' : (quoteLabelsById.get(String(value)) ?? '—')}
				/>
				<Column name="product_code" label={t('component.code')} minWidth={100} />
				<Column name="product_name" label={t('component.product')} minWidth={200} />
				<Column name="quantity" />
				<Column name="unit_price" label={t('component.unit_price')} />
				<Column name="discount_pct" label={t('component.discount_pct')} />
				<Column name="line_total" label={t('component.total')} />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet accounts()}
	<CollectionTable
		{client}
		collection="accounts"
		title={t('app.crm.tab_accounts')}
		description={t('app.crm.accounts_description')}
		query={{ where: { active: { eq: true } }, orderBy: { name: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="name" minWidth={240} card="title" />
			<Column name="industry" minWidth={160} card="subtitle" />
			<Column name="phone" minWidth={140} />
			<Column name="currency" card="badge" />
			<Column
				name="credit_limit"
				label={t('component.credit_available')}
				render={({ row }) => {
					if (row.credit_hold === true) return t('component.hold');
					if (row.credit_limit == null) return '—';
					return (Number(row.credit_limit) - Number(row.credit_used ?? 0)).toLocaleString();
				}}
			/>
			<Column name="active" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet contacts()}
	{#if selectedAccountId == null}
		<p class="text-sm text-muted-foreground">{t('app.crm.empty_contacts')}</p>
	{:else}
		<CollectionTable
			{client}
			collection="contacts"
			view={`crm:contacts:${selectedAccountId}`}
			title={t('app.crm.tab_contacts')}
			description={t('app.crm.contacts_description')}
			query={{
				where: { account_id: { eq: selectedAccountId }, active: { eq: true } },
				orderBy: { first_name: 'asc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column name="first_name" label={t('component.first_name')} card="title" />
				<Column name="last_name" label={t('component.last_name')} card="subtitle" />
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
		title={t('app.crm.tab_products')}
		description={t('app.crm.products_description')}
		query={{ where: { active: { eq: true } }, orderBy: { name: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="code" minWidth={120} card="badge" />
			<Column name="name" minWidth={240} card="title" />
			<Column name="spec" minWidth={160} />
			<Column name="unit" />
			<Column name="qty_on_hand" label={t('component.on_hand')} />
			<Column name="unit_price" label={t('component.unit_price')} />
			<Column name="active" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet activities()}
	{#if selectedAccountId == null}
		<p class="text-sm text-muted-foreground">{t('app.crm.empty_activities')}</p>
	{:else}
		<CollectionTable
			{client}
			collection="activities"
			view={`crm:activities:${selectedAccountId}`}
			title={t('app.crm.tab_activities')}
			description={t('app.crm.activities_description')}
			query={{
				where: {
					OR: [
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
					label={t('component.regarding')}
					minWidth={200}
					render={({ row, value }) => {
						const map = row.regarding_type === 'accounts' ? accountLabelsById : quoteLabelsById;
						return value == null || value === '' ? '—' : (map.get(String(value)) ?? '—');
					}}
				/>
				<Column name="due_date" label={t('component.due')} />
				<Column name="completed_at" label={t('component.completed')} />
				<Column
					name="owner_id"
					label={t('component.owner')}
					render={({ value }) =>
						value == null || value === '' ? '—' : (userLabelsById.get(String(value)) ?? '—')}
				/>
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet billing()}
	{#if selectedAccountId == null}
		<p class="text-sm text-muted-foreground">{t('app.crm.empty_billing')}</p>
	{:else}
		<CollectionTable
			{client}
			collection="sales_invoices"
			view={`crm:billing:${selectedAccountId}`}
			title={t('app.crm.billing_title')}
			description={t('app.crm.billing_description')}
			query={{
				where: { account_id: { eq: selectedAccountId } },
				orderBy: { doc_no: 'desc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column name="doc_no" label={t('component.doc_no')} minWidth={140} card="badge" />
				<Column
					name="quote_id"
					label={t('component.quote')}
					minWidth={200}
					card="title"
					render={({ value }) =>
						value == null || value === '' ? '—' : (quoteLabelsById.get(String(value)) ?? '—')}
				/>
				<Column name="status" card="badge" />
				<Column name="currency" card="badge" />
				<Column name="gross" label={t('component.gross_amount')} />
				<Column
					name="owner_id"
					label={t('component.owner')}
					render={({ value }) =>
						value == null || value === '' ? '—' : (userLabelsById.get(String(value)) ?? '—')}
				/>
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet billingLines()}
	{#if selectedAccountId == null}
		<p class="text-sm text-muted-foreground">{t('app.crm.empty_billing_lines')}</p>
	{:else if scopedInvoiceIds.length === 0}
		<p class="text-sm text-muted-foreground">{t('app.crm.no_invoice_lines')}</p>
	{:else}
		<CollectionTable
			{client}
			collection="sales_invoice_lines"
			view={`crm:billing-lines:${selectedAccountId}`}
			title={t('app.crm.billing_lines_title')}
			description={t('app.crm.billing_lines_description')}
			query={{
				where: { sales_invoice_id: { in: scopedInvoiceIds } },
				orderBy: { sales_invoice_id: 'desc' }
			}}
		>
			{#snippet columns({ Column })}
				<Column
					name="sales_invoice_id"
					label={t('component.invoice')}
					minWidth={140}
					card="badge"
					render={({ value }) =>
						value == null || value === '' ? '—' : (invoiceLabelsById.get(String(value)) ?? '—')}
				/>
				<Column name="product_code" label={t('component.code')} minWidth={100} />
				<Column name="product_name" label={t('component.product')} minWidth={200} card="title" />
				<Column name="quantity" />
				<Column name="unit_price" label={t('component.unit_price')} />
				<Column name="line_total" label={t('component.total')} />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet contracts()}
	{#if selectedAccountId == null}
		<p class="text-sm text-muted-foreground">{t('app.crm.empty_contracts')}</p>
	{:else if scopedQuoteIds.length === 0}
		<p class="text-sm text-muted-foreground">No quotes exist for this account yet.</p>
	{:else}
		<CollectionTable
			{client}
			collection="contract_signings"
			view={`crm:contracts:${selectedAccountId}`}
			title={t('app.crm.contracts_title')}
			description={t('app.crm.contracts_description')}
			query={{ where: { quote_id: { in: scopedQuoteIds } } }}
		>
			{#snippet columns({ Column })}
				<Column
					name="quote_id"
					label={t('component.quote')}
					minWidth={200}
					card="title"
					render={({ value }) =>
						value == null || value === '' ? '—' : (quoteLabelsById.get(String(value)) ?? '—')}
				/>
				<Column name="variant" card="badge" />
				<Column name="status" card="badge" />
				<Column name="acknowledged_at" label={t('component.acknowledged')} />
				<Column
					name="owner_id"
					label={t('component.owner')}
					render={({ value }) =>
						value == null || value === '' ? '—' : (userLabelsById.get(String(value)) ?? '—')}
				/>
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet payments()}
	{#if selectedAccountId == null}
		<p class="text-sm text-muted-foreground">{t('app.crm.empty_payments')}</p>
	{:else if scopedQuoteIds.length === 0}
		<p class="text-sm text-muted-foreground">No quotes exist for this account yet.</p>
	{:else}
		<CollectionTable
			{client}
			collection="settlements"
			view={`crm:payments:${selectedAccountId}`}
			title={t('app.crm.payments_title')}
			description={t('app.crm.payments_description')}
			query={{
				where: { regarding_type: { eq: 'quotes' }, regarding_id: { in: scopedQuoteIds } }
			}}
		>
			{#snippet columns({ Column })}
				<Column
					name="regarding_id"
					label={t('component.quote')}
					minWidth={200}
					card="title"
					render={({ value }) =>
						value == null || value === '' ? '—' : (quoteLabelsById.get(String(value)) ?? '—')}
				/>
				<Column name="amount" card="badge" />
				<Column name="currency" card="badge" />
				<Column name="settled_on" label={t('component.settled_on')} />
				<Column name="reference" minWidth={160} />
			{/snippet}
		</CollectionTable>
	{/if}
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow={t('app.crm.eyebrow')}
		title={t('app.crm.header_title')}
		description={t('app.crm.header_description')}
		actions={accountScopeActions}
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Tabs
		animate={false}
		config={[
			{
				name: 'pipeline',
				label: t('app.crm.tab_pipeline'),
				icon: 'lucide:kanban',
				content: pipeline
			},
			{ name: 'quotes', label: t('app.crm.tab_quotes'), icon: 'lucide:file-text', content: quotes },
			{
				name: 'quote-lines',
				label: t('app.crm.tab_quote_lines'),
				icon: 'lucide:list-checks',
				content: quoteLines
			},
			{
				name: 'accounts',
				label: t('app.crm.tab_accounts'),
				icon: 'lucide:building-2',
				content: accounts
			},
			{
				name: 'contacts',
				label: t('app.crm.tab_contacts'),
				icon: 'lucide:contact-round',
				content: contacts
			},
			{
				name: 'products',
				label: t('app.crm.tab_products'),
				icon: 'lucide:package',
				content: products
			},
			{
				name: 'activities',
				label: t('app.crm.tab_activities'),
				icon: 'lucide:calendar-check',
				content: activities
			},
			{
				name: 'billing',
				label: t('app.crm.billing_title'),
				icon: 'lucide:file-text',
				content: billing
			},
			{
				name: 'billing-lines',
				label: t('app.crm.billing_lines_title'),
				icon: 'lucide:list-checks',
				content: billingLines
			},
			{
				name: 'contracts',
				label: t('app.crm.contracts_title'),
				icon: 'lucide:file-signature',
				content: contracts
			},
			{
				name: 'payments',
				label: t('app.crm.payments_title'),
				icon: 'lucide:banknote',
				content: payments
			}
		] satisfies TabConfig[]}
	/>
</Cover>
