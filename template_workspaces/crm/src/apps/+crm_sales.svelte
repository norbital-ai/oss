<script lang="ts">
	import { client } from '$pod/client';
	import { CollectionKanban } from '@norbital-ai/ui/collection-kanban';
	import { CollectionTable } from '@norbital-ai/ui/collection-table';
	import { Cover, Inline, Stack } from '@norbital-ai/ui/layout';
	import { PageHeader } from '@norbital-ai/ui/page-header';
	import { Tabs, type TabConfig } from '@norbital-ai/ui/tabs';

	const quoteLanes = [
		{ value: 'draft', label: 'Draft', color: 'gray' },
		{ value: 'sent', label: 'Sent', color: 'blue' },
		{ value: 'won', label: 'Won', color: 'amber' },
		{ value: 'confirmed', label: 'Confirmed', color: 'green' },
		{ value: 'fulfilled', label: 'Fulfilled', color: 'emerald' }
	];

	let selectedOwnerId = $state('');

	const usersQuery = client.db.user.findMany({
		columns: { norbital_id: true, name: true },
		orderBy: { name: 'asc' }
	});

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
		content="Sales pipeline — quotes, accounts, contacts, product catalogue, and projects"
	/>
	<meta name="pod:icon" content="lucide:handshake" />
</svelte:head>

{#snippet pipeline()}
	<Stack gap="md">
		<Inline gap="sm">
			<label for="owner-filter" class="text-sm text-muted-foreground whitespace-nowrap">
				Owner
			</label>
			<select
				id="owner-filter"
				bind:value={selectedOwnerId}
				class="flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			>
				<option value="">All reps</option>
				{#each usersQuery.current ?? [] as user (user.norbital_id)}
					<option value={user.norbital_id}>{user.name || 'Unnamed rep'}</option>
				{/each}
			</select>
			{#if selectedOwnerId}
				<button
					type="button"
					onclick={() => (selectedOwnerId = '')}
					class="text-sm text-muted-foreground hover:text-foreground"
				>
					Clear
				</button>
			{/if}
		</Inline>
		<CollectionKanban {client} collection="quotes" groupBy="status" lanes={quoteLanes} rows={2}>
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
			<Column name="grade" minWidth={120} />
			<Column name="supplier" minWidth={140} />
			<Column name="unit" />
			<Column name="unit_price" label="Unit price" />
			<Column name="active" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet projects()}
	<CollectionTable
		{client}
		collection="projects"
		title="Projects"
		description="Customer or internal projects that quotes and activities can reference."
		query={{ orderBy: { name: 'asc' } }}
	>
		{#snippet columns({ Column })}
			<Column name="name" minWidth={240} card="title" />
			<Column name="account_id" label="Account" minWidth={200} />
			<Column name="status" card="badge" />
			<Column name="start_date" label="Start" />
			<Column name="end_date" label="End" />
			<Column name="owner_id" label="Owner" />
		{/snippet}
	</CollectionTable>
{/snippet}

{#snippet pageHeading()}
	<PageHeader
		eyebrow="CRM"
		title="Sales workspace"
		description="Manage your sales pipeline, accounts, contacts, catalogue, and projects."
	/>
{/snippet}

<Cover as="main" top={pageHeading}>
	<Tabs
		animate={false}
		config={[
			{ name: 'pipeline', label: 'Pipeline', icon: 'lucide:kanban', content: pipeline },
			{ name: 'accounts', label: 'Accounts', icon: 'lucide:building-2', content: accounts },
			{ name: 'contacts', label: 'Contacts', icon: 'lucide:contact-round', content: contacts },
			{ name: 'products', label: 'Products', icon: 'lucide:package', content: products },
			{ name: 'projects', label: 'Projects', icon: 'lucide:flask-conical', content: projects }
		] satisfies TabConfig[]}
	/>
</Cover>
