<!-- fallow-ignore-file complexity -- recursive tree navigation intentionally centralizes keyboard, selection, and accessibility states -->
<script lang="ts" generics="TMetadata">
	import Icon from '@iconify/svelte';
	import { Button } from '#lib/button';
	import { Checkbox } from '#lib/checkbox';
	import { Input } from '#lib/input';
	import { ScrollArea } from '#lib/scroll-area';
	import { cn } from '#lib/utils';
	import { Tabs as TabsPrimitive } from 'bits-ui';
	import TabsContent from '../tabs/tabs-content.svelte';
	import TabsList from '../tabs/tabs-list.svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import type { NodeActionCallback, TreeNodes, TreeSelectProps } from './index.js';
	import { isParentNode, isRequiredChildNode, TreeState } from './tree-select-state.svelte';

	const INDENTATION_WIDTH = 18;

	let {
		rootItems = [],
		value = $bindable(),
		onChange,
		disabled = false,
		readonly = false,
		showSearch = false,
		searchPlaceholder = 'Search...',
		containerClass = '',
		multiple = false
	}: TreeSelectProps<TMetadata> = $props();

	type TreeNode = TreeNodes<TMetadata>;

	const treeState = $derived.by(
		() =>
			new TreeState({
				rootItems,
				value,
				onChange,
				multiple
			})
	);

	type RootAction = TreeNode extends { action?: infer A }
		? A
		: NodeActionCallback<TMetadata> | undefined;

	let treeContainerElement: HTMLDivElement | null = $state(null);
	let inputElement: HTMLInputElement | null = $state(null);
	let scrollViewportRef: HTMLElement | null = $state(null);

	let inputMode = $state<'keyboard' | 'mouse'>('mouse');

	// Indicator State
	let isInputFocused = $state(false);

	// Keep the focus ring for keyboard navigation. Pointer hover uses a quiet tonal fill.
	const shouldShowIndicator = $derived(showSearch && inputMode === 'keyboard' && isInputFocused);

	const hasMultipleRoots = $derived(treeState.rootNodes.length > 1);
	const activeTabValue = $derived(treeState.rootNodes[treeState.activeRootIndex]?.id || '');

	// Tab items for data-driven Tabs.List
	const rootTabItems = $derived(
		treeState.rootNodes.map((node) => ({
			value: node.id,
			label: node.title,
			_node: node
		}))
	);

	const visibleNodesArray = $derived(treeState.visibleNodes);

	const nodeIndexMap = $derived.by(() => {
		const map = new SvelteMap<string, number>();
		visibleNodesArray.forEach((node, idx) => map.set(node.id, idx));
		return map;
	});

	// Logic Handlers
	function handleSelection(nodeId: string, fromMouse: boolean = false) {
		if (disabled || readonly) return;
		if (fromMouse) inputMode = 'mouse';

		const node = treeState.findNode(nodeId);
		if (!node) return;

		if (!multiple) {
			const isAlreadySelected = node.isSelected;
			treeState.clearAllSelections();
			if (isAlreadySelected) return;
		}

		if (isParentNode(node) && !node.isExpanded) {
			treeState.toggleExpand(node.id);
		}

		treeState.toggleSelection(nodeId);
	}

	function navigateToIndex(index: number, shouldScroll: boolean = true) {
		const node = visibleNodesArray[index];
		if (node) {
			treeState.setActiveNode(node.id);
			if (shouldScroll) scrollActiveNodeIntoView();
		}
	}

	function navigateDown() {
		const maxIndex = visibleNodesArray.length - 1;
		if (maxIndex < 0) return;
		inputMode = 'keyboard';
		if (treeState.activeNodeId === null) {
			navigateToIndex(0);
			return;
		}
		const currentIndex = nodeIndexMap.get(treeState.activeNodeId) ?? 0;
		const nextIndex = (currentIndex + 1) % (maxIndex + 1);
		navigateToIndex(nextIndex);
	}

	function navigateUp() {
		const maxIndex = visibleNodesArray.length - 1;
		if (maxIndex < 0) return;
		inputMode = 'keyboard';
		if (treeState.activeNodeId === null) {
			navigateToIndex(maxIndex);
			return;
		}
		const currentIndex = nodeIndexMap.get(treeState.activeNodeId) ?? 0;
		const prevIndex = currentIndex === 0 ? maxIndex : currentIndex - 1;
		navigateToIndex(prevIndex);
	}

	function handleArrowRight() {
		inputMode = 'keyboard';
		if (!treeState.activeNodeId) {
			navigateToIndex(0);
			return;
		}
		const node = treeState.findNode(treeState.activeNodeId);
		if (!node || node.disabled) return;
		if (isParentNode(node)) {
			if (!node.isExpanded) {
				treeState.toggleExpand(node.id);
				scrollActiveNodeIntoView();
			} else {
				navigateDown();
			}
		}
	}

	function handleArrowLeft() {
		inputMode = 'keyboard';
		if (!treeState.activeNodeId) {
			const maxIndex = visibleNodesArray.length - 1;
			if (maxIndex >= 0) navigateToIndex(maxIndex);
			return;
		}
		const node = treeState.findNode(treeState.activeNodeId);
		if (!node) return;
		if (isParentNode(node) && node.isExpanded) {
			treeState.toggleExpand(node.id);
			scrollActiveNodeIntoView();
		} else if (node.parentNode && node.parentNode.depth > 0) {
			treeState.setActiveNode(node.parentNode.id);
			scrollActiveNodeIntoView();
		}
	}

	function findByFirstLetter(letter: string): string | null {
		if (visibleNodesArray.length === 0) return null;
		const letterLower = letter.toLowerCase();
		const startIdx = treeState.activeNodeId
			? ((nodeIndexMap.get(treeState.activeNodeId) ?? -1) + 1) % visibleNodesArray.length
			: 0;
		const searchOrder = [
			...visibleNodesArray.slice(startIdx),
			...visibleNodesArray.slice(0, startIdx)
		];
		const match = searchOrder.find((node) => node.title.toLowerCase().startsWith(letterLower));
		return match?.id ?? null;
	}

	function handleWindowKeydown(event: KeyboardEvent) {
		if (disabled || !showSearch) return;

		const active = document.activeElement as HTMLElement | null;
		const isInputActive = active === inputElement;
		if (!isInputActive) return;

		const navigationKeys = [
			'ArrowDown',
			'ArrowUp',
			'ArrowLeft',
			'ArrowRight',
			'Enter',
			' ',
			'Home',
			'End'
		];
		const isLetterKey = event.key.length === 1 && /^[a-zA-Z]$/.test(event.key);
		const isNavigationKey = navigationKeys.includes(event.key);
		if (!isNavigationKey && !isLetterKey) return;

		if (isNavigationKey || isLetterKey) inputMode = 'keyboard';
		const isSpaceForTyping = event.key === ' ' && inputElement && inputElement.value.length > 0;

		if (isNavigationKey && !isSpaceForTyping) event.preventDefault();

		const currentNode = treeState.activeNodeId ? treeState.findNode(treeState.activeNodeId) : null;

		switch (event.key) {
			case 'ArrowDown':
				navigateDown();
				break;
			case 'ArrowUp':
				navigateUp();
				break;
			case 'ArrowRight':
				handleArrowRight();
				break;
			case 'ArrowLeft':
				handleArrowLeft();
				break;
			case 'Enter':
			case ' ':
				if (treeState.activeNodeId && currentNode) {
					if (event.key === ' ' && isSpaceForTyping) break;
					if (isParentNode(currentNode) && !currentNode.disabled) {
						treeState.toggleExpand(currentNode.id);
					} else if (!readonly) {
						handleSelection(treeState.activeNodeId);
					}
				}
				break;
			case 'Home':
				navigateToIndex(0);
				break;
			case 'End':
				navigateToIndex(visibleNodesArray.length - 1);
				break;
			default:
				if (isLetterKey) {
					const nodeId = findByFirstLetter(event.key);
					if (nodeId) {
						treeState.setActiveNode(nodeId);
						scrollActiveNodeIntoView();
					}
				}
		}
	}

	function handleNodeMouseEnter(nodeId: string) {
		if (inputMode === 'mouse') {
			treeState.setActiveNode(nodeId);
		}
	}

	function handleMouseMove() {
		if (inputMode !== 'mouse') {
			inputMode = 'mouse';
		}
	}

	function handleInputFocus() {
		isInputFocused = true;
		inputMode = 'keyboard';
	}

	function handleInputBlur() {
		isInputFocused = false;
	}

	function handleRootTabChange(rootId: string) {
		if (disabled) return;
		const index = treeState.rootNodes.findIndex((node) => node.id === rootId);
		if (index !== -1) treeState.setActiveRootIndex(index);
	}

	function scrollActiveNodeIntoView() {
		if (!scrollViewportRef || !treeContainerElement || !treeState.activeNodeId) return;
		const activeEl = treeContainerElement.querySelector<HTMLElement>(
			`[data-node-path="${treeState.activeNodeId}"]`
		);
		if (!activeEl) return;
		const viewportRect = scrollViewportRef.getBoundingClientRect();
		const activeRect = activeEl.getBoundingClientRect();
		if (activeRect.top >= viewportRect.top && activeRect.bottom <= viewportRect.bottom) return;

		const scrollTop = scrollViewportRef.scrollTop;
		const offset = activeRect.top - viewportRect.top;
		const targetScroll = scrollTop + offset - viewportRect.height / 2 + activeRect.height / 2;
		scrollViewportRef.scrollTo({ top: targetScroll, behavior: 'smooth' });
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

{#snippet renderAction(action: RootAction | undefined, node: TreeNode)}
	{#if action}
		{@const actualized = action(node)}
		<div class="relative z-10">
			{#if actualized && typeof actualized === 'object' && 'component' in actualized}
				{@const { component: Component, props } = actualized}
				<Component {...props} />
			{:else if actualized && typeof actualized === 'object' && 'snippet' in actualized}
				{@const { snippet, params } = actualized}
				{@render snippet(params)}
			{:else}
				{actualized}
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet renderCurrentLevelConnector(node: TreeNode, currentIsLast: boolean)}
	{#if node.displayDepth > 0 && node.parentNode?.depth !== 0}
		{#if currentIsLast}
			<div
				class="absolute"
				style="left: {(node.displayDepth - 1) * INDENTATION_WIDTH}px; top: 0; height: 100%;"
			>
				<div
					class="absolute w-px bg-secondary dark:bg-secondary"
					style="left: 9px; top: 0; bottom: 50%;"
				></div>
				<div
					class="absolute h-px w-2.5 bg-secondary dark:bg-secondary"
					style="left: 9px; top: 50%;"
				></div>
			</div>
		{:else}
			<div
				class="absolute"
				style="left: {(node.displayDepth - 1) * INDENTATION_WIDTH}px; top: 0; height: 100%;"
			>
				<div class="absolute left-[9px] h-full w-px bg-secondary dark:bg-secondary"></div>
				<div class="absolute top-1/2 left-[9px] h-px w-2.5 bg-secondary dark:bg-secondary"></div>
			</div>
		{/if}
	{/if}
{/snippet}

{#snippet renderNodeContent(node: TreeNode)}
	{@const matchInfo = treeState.matchInfo.get(node.id)}
	<div class={cn('flex h-7 grow items-center justify-start', { 'opacity-50': node.disabled })}>
		<div class="flex h-7 w-4 items-center justify-center">
			{#if isParentNode(node)}
				<Icon
					icon={node.isExpanded ? 'lucide:chevron-down' : 'lucide:chevron-right'}
					class="h-3 w-3 text-muted-foreground dark:text-muted-foreground"
					aria-hidden="true"
				/>
			{/if}
		</div>
		<div class="flex h-7 w-6 items-center justify-center">
			<Icon
				icon={node.icon}
				class="h-3.5 w-3.5 text-muted-foreground dark:text-muted-foreground"
				aria-hidden="true"
			/>
		</div>
		<span
			class="ml-2 flex grow flex-row truncate text-start text-xs text-secondary-foreground dark:text-muted-foreground"
		>
			{#if matchInfo}
				<span class="flex w-min flex-row">
					{node.title.slice(0, matchInfo.start)}
					<span class="bg-brand-100 dark:bg-brand-200"
						>{node.title.slice(matchInfo.start, matchInfo.end)}</span
					>
					{node.title.slice(matchInfo.end)}
				</span>
			{:else}
				{node.title}
			{/if}
			{#if isRequiredChildNode(node)}
				<span class="ml-0.5 text-xs text-rose-500 dark:text-rose-400">*</span>
			{/if}
		</span>
		{#if !multiple && !isParentNode(node) && node.isSelected}
			<div
				class="absolute right-2 flex h-4 w-4 items-center justify-center rounded-full bg-brand-100 dark:bg-brand-900"
			>
				<Icon
					icon="lucide:check"
					class="h-2.5 w-2.5 text-brand dark:text-brand-400"
					aria-hidden="true"
				/>
			</div>
		{/if}
	</div>
{/snippet}

{#snippet renderTreeNode(node: TreeNode, isLast: boolean)}
	{@const isDirectChild = node.parentNode?.depth === 0}
	{@const isActive = treeState.activeNodeId === node.id}
	<li class="relative">
		<div
			role="none"
			class="group relative flex w-full items-center py-0.5 text-sm"
			style="padding-left: {isDirectChild ? 0 : 8}px;"
			onmouseenter={() => handleNodeMouseEnter(node.id)}
		>
			{#if node.depth > 0 && !isDirectChild}
				{@render renderCurrentLevelConnector(node, isLast)}
			{/if}
			<div class="relative flex flex-1 items-center">
				<Button
					variant="ghost"
					role="treeitem"
					aria-level={node.displayDepth}
					aria-expanded={isParentNode(node) ? node.isExpanded : undefined}
					aria-selected={!isParentNode(node) ? node.isSelected : undefined}
					id={`treeitem-${node.id}`}
					tabindex={-1}
					disabled={node.disabled}
					data-node-path={node.id}
					data-active={isActive ? 'true' : undefined}
					data-selected={node.isSelected ? 'true' : undefined}
					onclick={() => {
						inputMode = 'mouse';
						if (isParentNode(node)) {
							treeState.toggleExpand(node.id);
						} else {
							handleSelection(node.id, true);
						}
					}}
					class={cn(
						'relative z-1 flex flex-1 justify-start rounded px-0.5 text-xs transition-colors duration-150 hover:bg-accent/50 focus:bg-accent/50 focus:outline-none focus-visible:ring-0 focus-visible:outline-none active:bg-accent/70',
						{
							'cursor-pointer': !node.disabled,
							'cursor-not-allowed': node.disabled,
							'bg-accent text-accent-foreground hover:bg-accent focus:bg-accent active:bg-accent':
								node.isSelected
						}
					)}
					style="margin-left: {isDirectChild ? 0 : node.displayDepth * INDENTATION_WIDTH}px;"
				>
					{#if isActive && shouldShowIndicator}
						<span
							class="pointer-events-none absolute inset-0 z-0 rounded-md ring-2 ring-primary/60 ring-inset"
						></span>
					{/if}
					{@render renderNodeContent(node)}
				</Button>
				{#if node.action}
					<div class="absolute right-1 z-10 flex items-center">
						{@render renderAction(node.action, node)}
					</div>
				{/if}
			</div>
			{#if multiple}
				<div class={cn('ml-2 flex-none', { 'opacity-50': node.disabled })}>
					<Checkbox
						indeterminate={isParentNode(node) && node.isIndeterminate}
						checked={node.isSelected}
						onclick={(event: MouseEvent) => {
							event.preventDefault();
							handleSelection(node.id, true);
						}}
						disabled={disabled || readonly || node.disabled}
						aria-readonly={readonly}
						class="relative z-10"
					/>
				</div>
			{/if}
		</div>
	</li>
{/snippet}

{#snippet renderNodeList(nodes: TreeNode[])}
	<ul class="flex flex-col p-2" role="tree" aria-multiselectable={multiple}>
		{#each nodes as node, index (node.id)}
			{@render renderTreeNode(node, index === nodes.length - 1)}
		{/each}
	</ul>
{/snippet}

{#snippet renderRootTabContent(rootNode: (typeof treeState.rootNodes)[0])}
	<TabsContent
		value={rootNode.id}
		class="relative mt-0"
		bind:ref={treeContainerElement}
		tabindex={-1}
		role="tree"
		aria-multiselectable={multiple}
		aria-label="Tree navigation"
		onmousemove={handleMouseMove}
	>
		{@render renderNodeList(treeState.visibleNodes)}
	</TabsContent>
{/snippet}

<div class={cn('relative flex flex-col space-y-2', containerClass)} data-input-mode={inputMode}>
	{#if hasMultipleRoots}
		<TabsPrimitive.Root class="relative" value={activeTabValue} onValueChange={handleRootTabChange}>
			<TabsList class="py-0" tabs={rootTabItems}>
				{#snippet itemSnippet({ tab })}
					<span class="flex items-center gap-2">
						{#if tab.value === 'scope.existing' || tab.value === 'default'}
							<Icon icon="lucide:database" aria-hidden="true" />
						{:else}
							<Icon icon="lucide:file-pen" aria-hidden="true" />
						{/if}
						{tab.label}
					</span>
				{/snippet}
			</TabsList>
			<div class="mt-2 flex flex-row items-center gap-2">
				{#if showSearch}
					<div class="relative flex-1 p-1">
						<Input
							type="text"
							placeholder={searchPlaceholder}
							bind:value={treeState.filterValue}
							class="w-full text-sm"
							tabindex={0}
							bind:ref={inputElement}
							aria-label="Search tree"
							onfocus={handleInputFocus}
							onblur={handleInputBlur}
						/>
						<Icon
							icon="lucide:search"
							class="absolute top-1/2 right-3 z-20 -translate-y-1/2 transform text-muted-foreground dark:text-muted-foreground"
							aria-hidden="true"
						/>
					</div>
				{/if}
				{#if treeState.activeRootNode}
					{@const rootNode = treeState.activeRootNode}
					{@render renderAction(rootNode.action, rootNode)}
				{/if}
			</div>
			{#each treeState.rootNodes as rootNode (rootNode.id)}
				{@render renderRootTabContent(rootNode)}
			{/each}
		</TabsPrimitive.Root>
	{/if}

	{#if !hasMultipleRoots}
		<div class="flex flex-row items-center gap-2">
			{#if showSearch}
				<div class="relative flex-1 p-1">
					<Input
						type="text"
						placeholder={searchPlaceholder}
						bind:value={treeState.filterValue}
						class="w-full text-sm"
						tabindex={0}
						bind:ref={inputElement}
						{disabled}
						aria-label="Search tree"
						onfocus={handleInputFocus}
						onblur={handleInputBlur}
					/>
					<Icon
						icon="lucide:search"
						class="absolute top-1/2 right-3 z-20 -translate-y-1/2 transform text-muted-foreground dark:text-muted-foreground"
						aria-hidden="true"
					/>
				</div>
			{/if}
			{#if treeState.activeRootNode}
				{@const rootNode = treeState.activeRootNode}
				{@render renderAction(rootNode.action, rootNode)}
			{/if}
		</div>
		<ScrollArea class="flex-1" bind:viewportRef={scrollViewportRef}>
			<div
				class="relative flex flex-1 flex-col bg-transparent"
				bind:this={treeContainerElement}
				tabindex="-1"
				role="tree"
				aria-multiselectable={multiple}
				aria-label="Tree navigation"
				onmousemove={handleMouseMove}
			>
				{#if treeState.visibleNodes.length > 0}
					{@render renderNodeList(treeState.visibleNodes)}
				{:else}
					<p class="p-2 text-xs text-muted-foreground italic dark:text-muted-foreground">
						No items to display
					</p>
				{/if}
			</div>
		</ScrollArea>
	{/if}
</div>
