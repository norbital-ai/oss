<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionKanban } from '@norbital-ai/ui/collection-kanban';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Combobox } from '@norbital-ai/ui/combobox';
	import { Cover, Stack } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';

	const quoteLanes = [
		{ value: 'draft', label: 'Draft', color: 'gray' },
		{ value: 'sent', label: 'Sent', color: 'blue' },
		{ value: 'won', label: 'Won', color: 'amber' },
		{ value: 'confirmed', label: 'Confirmed', color: 'green' },
		{ value: 'lost', label: 'Lost', color: 'red' }
	];

	let selectedOwnerId = $state('');

	const usersQuery = client.db.user.findMany({
		columns: { norbital_id: true, name: true },
		orderBy: { name: 'asc' }
	});

	const ownerOptions = $derived([
		{ value: '', label: 'All reps' },
		...(usersQuery.current ?? []).map((user) => ({
			value: user.norbital_id,
			label: user.name || 'Unnamed rep'
		}))
	]);

	const pipelineDashboard = $derived.by(() => {
		return selectedOwnerId
			? client.invoke.pipeline_dashboard({ owner_id: selectedOwnerId })
			: client.invoke.pipeline_dashboard({});
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
	<CollectionTable
		{client}
		collection="quotes"
		view="all_quotes"
		title="Quotes"
		description="Every sales document, including lost and cancelled deals."
		query={{ orderBy: { doc_no: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="doc_no" label="Doc #" minWidth={140} card="badge" />
			<Column name="title" minWidth={240} card="title" />
			<Column name="account_id" label="Account" minWidth={200} />
			<Column name="status" card="badge" />
			<Column name="gross" label="Amount" />
			<Column name="currency" />
			<Column name="valid_until" label="Valid until" />
			<Column name="confirmed_at" label="Confirmed" />
			<Column name="owner_id" label="Owner" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet quoteLines()}
	<CollectionTable
		{client}
		collection="quote_lines"
		title="Quote lines"
		description="Line items across all quotes."
		query={{ orderBy: { quote_id: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="quote_id" label="Quote" minWidth={200} card="title" />
			<Column name="product_code" label="Code" minWidth={100} />
			<Column name="product_name" label="Product" minWidth={200} />
			<Column name="quantity" />
			<Column name="unit_price" label="Unit price" />
			<Column name="discount_pct" label="Discount %" />
			<Column name="line_total" label="Total" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet accounts()}
	<CollectionTable
		{client}
		collection="accounts"
		title="Accounts"
		description="Companies and organizations in your pipeline."
		query={{ orderBy: { name: 'asc' } }}
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
	<CollectionTable
		{client}
		collection="contacts"
		title="Contacts"
		description="People at your accounts — decision-makers and day-to-day contacts."
		query={{ orderBy: { first_name: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="first_name" label="First name" card="title" />
			<Column name="last_name" label="Last name" card="subtitle" />
			<Column name="email" minWidth={200} />
			<Column name="title" />
			<Column name="department" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet products()}
	<CollectionTable
		{client}
		collection="products"
		title="Products"
		description="Sellable catalogue. Quote lines snapshot from here at creation."
		query={{ orderBy: { name: 'asc' } }}
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
	<CollectionTable
		{client}
		collection="activities"
		title="Activities"
		description="Calls, meetings, emails, tasks, and notes across accounts and deals."
		query={{ orderBy: { due_date: 'desc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="subject" minWidth={280} card="title" />
			<Column name="type" card="badge" />
			<Column name="regarding_type" label="Regarding" />
			<Column name="due_date" label="Due" />
			<Column name="completed_at" label="Completed" />
			<Column name="owner_id" label="Owner" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="CRM"
		title="Sales workspace"
		description="Manage the pipeline, quotes, accounts, contacts, catalogue, and team activities."
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
