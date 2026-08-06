<script lang="ts">
	import Icon from '@iconify/svelte';
	import { getErrorMessage, withTimeout } from '@norbital-ai/std';
	import { Button } from '@norbital-ai/ui/button';
	import { useI18n } from '@norbital-ai/ui/i18n';
	import type { TenantI18nKeys } from '$pod/i18n-keys';
	import { Bound, Inline, Scroll, Stack } from '@norbital-ai/ui/layout';
	import { cn } from '@norbital-ai/ui/utils';
	import { watch } from 'runed';
	import { convertIfcToFragments } from './ifc_viewer.converter.js';
	import type {
		IFCViewerMarkerGroup,
		IFCViewerProps,
		ViewerColor,
		ViewerColorConstructor,
		ViewerComponents,
		ViewerComponentsModule,
		ViewerFragmentsManager,
		ViewerFragmentsModel,
		ViewerFragmentsModule,
		ViewerFrontendModule,
		ViewerHighlighter,
		ViewerItemData,
		ViewerThreeModule,
		ViewerWorld
	} from './ifc_viewer.types.js';

	const viewerLibraries: Promise<
		[ViewerComponentsModule, ViewerFrontendModule, ViewerFragmentsModule, ViewerThreeModule]
	> = Promise.all([
		import(
			/* @vite-ignore */ 'https://esm.sh/@thatopen/components@3.4.6?deps=three@0.185.1,@thatopen/fragments@3.4.6,web-ifc@0.0.77,camera-controls@3.1.2'
		),
		import(
			/* @vite-ignore */ 'https://esm.sh/@thatopen/components-front@3.4.3?deps=@thatopen/components@3.4.6,@thatopen/fragments@3.4.6,three@0.185.1,web-ifc@0.0.77,camera-controls@3.1.2'
		),
		import(
			/* @vite-ignore */ 'https://esm.sh/@thatopen/fragments@3.4.6?deps=three@0.185.1,web-ifc@0.0.77'
		),
		import(/* @vite-ignore */ 'https://esm.sh/three@0.185.1')
	]);

	function normalizeFileUrlForSameOrigin(rawUrl: string, origin: string): string {
		try {
			const base = origin.endsWith('/') ? origin : `${origin}/`;
			const parsed = new URL(rawUrl, base);
			if (parsed.pathname.startsWith('/api/file/')) {
				const originRoot = origin.replace(/\/$/, '');
				return `${originRoot}${parsed.pathname}${parsed.search}${parsed.hash}`;
			}
			return parsed.href;
		} catch {
			return rawUrl;
		}
	}

	type SelectedItem = {
		modelId: string;
		id: number;
		title: string;
		subtitle: string | null;
		properties: string;
	};

	type LoadBanner = 'none' | 'loading' | { error: string };

	type IFCViewerRuntime = {
		OBC: ViewerComponentsModule;
		OBF: ViewerFrontendModule;
		FRAGS: ViewerFragmentsModule;
		THREE: ViewerThreeModule;
		components: ViewerComponents;
		world: ViewerWorld;
		fragments: ViewerFragmentsManager;
		highlighter: ViewerHighlighter | null;
		currentGroup: ViewerFragmentsModel | null;
		markerStyleIds: string[];
	};

	const IFC_FETCH_TIMEOUT_MS = 120_000;
	const IFC_CONVERSION_TIMEOUT_MS = 60_000;
	const IFC_FRAGMENT_LOAD_TIMEOUT_MS = 120_000;
	const DEFAULT_BACKGROUND_COLOR = 'var(--color-background)';
	const DEFAULT_SELECTION_COLOR = 'var(--color-brand)';
	const DEFAULT_MARKER_COLOR = 'var(--color-muted-foreground)';
	const DEFAULT_SHOW_GRID = false;

	function resolveCssColor(css: string): string {
		if (typeof document === 'undefined') return '#f2f1ed';
		if (!css.startsWith('var(')) return css;
		const name = css.slice(4, -1).trim();
		const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		return value || '#f2f1ed';
	}

	interface Props extends IFCViewerProps {}

	let { src, alt, markers = [], markerGroups }: Props = $props();

	const { t } = useI18n<TenantI18nKeys>();

	const trimmedSrc = $derived(src?.trim() ?? '');
	const markerKey = $derived(markers.join(','));

	const normalizedMarkerGroups = $derived.by(() => {
		if (!markerGroups?.length) return [];
		return markerGroups
			.map((group: IFCViewerMarkerGroup) => ({
				label: group.label,
				color: group.color,
				expressIds: group.expressIds
			}))
			.filter((group) => group.expressIds.length > 0);
	});

	const markerGroupsKey = $derived(JSON.stringify(normalizedMarkerGroups));

	let selectedItem = $state<SelectedItem | null>(null);
	let loadBanner = $state<LoadBanner>('none');
	let interactionLocked = $state(true);
	let propertiesOpen = $state(false);

	let viewer: IFCViewerRuntime | null = null;
	let markerSyncFrame = 0;

	async function fetchIfcModelResponse(url: string): Promise<Response> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => {
			controller.abort();
		}, IFC_FETCH_TIMEOUT_MS);

		try {
			return await fetch(url, { signal: controller.signal });
		} finally {
			clearTimeout(timeoutId);
		}
	}

	function assertIfcBodyNotHtml(response: Response, buffer: Uint8Array): void {
		const contentType = response.headers.get('content-type') ?? '';
		if (contentType.toLowerCase().includes('text/html')) {
			throw new Error(t('component.ifc_html_instead_of_bytes'));
		}

		const headLen = Math.min(120, buffer.length);
		if (headLen === 0) return;

		const head = new TextDecoder('utf-8', { fatal: false }).decode(buffer.subarray(0, headLen));
		const trimmed = head.trimStart();
		const lower = trimmed.toLowerCase();
		if (lower.startsWith('<!doctype html') || lower.startsWith('<html')) {
			throw new Error(t('component.ifc_html_instead_of_bytes'));
		}
	}

	function getModelName(url: string): string {
		try {
			const parsed = new URL(url, window.location.href);
			const fileName = parsed.pathname.split('/').pop()?.trim();
			if (fileName) return fileName;
		} catch (error) {
			console.debug('[IFCViewer] Using the fallback filename for an invalid model URL.', error);
		}
		return 'ifc-model.ifc';
	}

	function resetSelectionState(): void {
		propertiesOpen = false;
		selectedItem = null;
	}

	function clearSelection(): void {
		resetSelectionState();
		const highlighter = viewer?.highlighter;
		if (highlighter) {
			highlighter.clear('select');
		}
	}

	function applyInteractionLock(runtime: IFCViewerRuntime, locked: boolean): void {
		runtime.world.camera.enabled = !locked;
	}

	function toggleInteractionLock(): void {
		interactionLocked = !interactionLocked;
	}

	function cancelScheduledMarkerVisualization(): void {
		if (markerSyncFrame === 0 || typeof cancelAnimationFrame !== 'function') return;
		cancelAnimationFrame(markerSyncFrame);
		markerSyncFrame = 0;
	}

	function scheduleMarkerVisualization(): void {
		if (typeof requestAnimationFrame !== 'function') {
			void syncMarkerVisualization();
			return;
		}

		cancelScheduledMarkerVisualization();
		markerSyncFrame = requestAnimationFrame(() => {
			markerSyncFrame = 0;
			void syncMarkerVisualization();
		});
	}

	function parseMarkerColor(css: string, Color: ViewerColorConstructor): ViewerColor {
		const color = new Color();
		try {
			color.setStyle(resolveCssColor(css.trim()));
		} catch {
			color.setStyle(resolveCssColor(DEFAULT_MARKER_COLOR));
		}
		return color;
	}

	function readPropertyValue(properties: ViewerItemData | null, key: string): string | null {
		if (properties == null) return null;
		const rawValue = properties[key];
		if (rawValue == null || Array.isArray(rawValue)) return null;
		if (typeof rawValue.value === 'string' || typeof rawValue.value === 'number') {
			return String(rawValue.value);
		}
		return null;
	}

	function buildSelectedItem(
		modelId: string,
		id: number,
		properties: ViewerItemData | null
	): SelectedItem {
		const name = readPropertyValue(properties, 'Name');
		const entityType = readPropertyValue(properties, 'type');
		const globalId = readPropertyValue(properties, 'GlobalId');
		const subtitleParts = [entityType, globalId ? `Global ID ${globalId}` : null].filter(
			(part): part is string => part != null
		);

		return {
			modelId,
			id,
			title: name ?? `Element #${id}`,
			subtitle: subtitleParts.length > 0 ? subtitleParts.join(' • ') : null,
			properties: JSON.stringify(properties, null, 2)
		};
	}

	async function clearMarkerVisualization(runtime: IFCViewerRuntime): Promise<void> {
		const highlighter = runtime.highlighter;
		if (highlighter === null) {
			runtime.markerStyleIds = [];
			return;
		}

		// stupidity:allow A6 -- Highlighter state must be cleared before the matching style is deleted.
		for (const styleId of runtime.markerStyleIds) {
			await highlighter.clear(styleId);
			highlighter.styles.delete(styleId);
		}

		runtime.markerStyleIds = [];
	}

	async function clearModel(runtime: IFCViewerRuntime): Promise<void> {
		await clearMarkerVisualization(runtime);
		if (runtime.highlighter !== null) {
			runtime.highlighter.clear('select');
		}
		resetSelectionState();
		const group = runtime.currentGroup;
		if (group == null) return;
		runtime.world.scene.three.remove(group.object);
		await runtime.fragments.core.disposeModel(group.modelId);
		runtime.currentGroup = null;
	}

	async function createViewerRuntime(container: HTMLDivElement): Promise<IFCViewerRuntime> {
		const [OBC, OBF, FRAGS, THREE] = await viewerLibraries;
		const components = new OBC.Components();
		const worlds = components.get(OBC.Worlds);
		const world = worlds.create();

		world.scene = new OBC.SimpleScene(components);
		world.scene.setup();
		world.scene.three.background = new THREE.Color(resolveCssColor(DEFAULT_BACKGROUND_COLOR));

		world.renderer = new OBC.SimpleRenderer(components, container);
		world.camera = new OBC.SimpleCamera(components);

		components.init();

		if (DEFAULT_SHOW_GRID) {
			components.get(OBC.Grids).create(world);
		}

		const fragments = components.get(OBC.FragmentsManager);
		fragments.init(await OBC.FragmentsManager.getWorker());

		return {
			OBC,
			OBF,
			FRAGS,
			THREE,
			components,
			world,
			fragments,
			highlighter: null,
			currentGroup: null,
			markerStyleIds: []
		};
	}

	function ensureInteractionSystems(runtime: IFCViewerRuntime): ViewerHighlighter {
		if (runtime.highlighter !== null) {
			return runtime.highlighter;
		}

		const { OBC, OBF, THREE, components, world } = runtime;
		components.get(OBC.Raycasters).get(world);
		const highlighter = components.get(OBF.Highlighter);
		highlighter.setup({
			world,
			autoHighlightOnClick: false,
			selectionColor: new THREE.Color(resolveCssColor(DEFAULT_SELECTION_COLOR))
		});
		highlighter.multiple = 'none';
		highlighter.zoomToSelection = false;
		runtime.highlighter = highlighter;
		return highlighter;
	}

	async function disposeRuntime(runtime: IFCViewerRuntime): Promise<void> {
		await clearModel(runtime);
		runtime.components.dispose();
	}

	async function loadIfcModelIntoRuntime(runtime: IFCViewerRuntime, url: string): Promise<void> {
		const fetchUrl = normalizeFileUrlForSameOrigin(url, window.location.origin);

		const response = await fetchIfcModelResponse(fetchUrl);
		if (!response.ok) {
			throw new Error(t('component.ifc_download_failed', { status: response.status }));
		}

		const buffer = new Uint8Array(await response.arrayBuffer());
		assertIfcBodyNotHtml(response, buffer);

		const modelName = getModelName(fetchUrl);
		const fragmentBytes = await withTimeout(
			() => convertIfcToFragments(buffer, t),
			IFC_CONVERSION_TIMEOUT_MS,
			t('component.ifc_conversion')
		);

		const group = await withTimeout(
			() =>
				runtime.fragments.core.load(fragmentBytes, {
					modelId: modelName,
					camera: runtime.world.camera.three
				}),
			IFC_FRAGMENT_LOAD_TIMEOUT_MS,
			t('component.ifc_fragment_load')
		);

		runtime.world.scene.three.add(group.object);
		runtime.currentGroup = group;
	}

	function viewerAttachment(url: string) {
		return (node: Element) => {
			if (!(node instanceof HTMLDivElement)) {
				throw new Error('IFC viewer must be mounted on a div element');
			}
			const container = node;
			let cancelled = false;
			let myRuntime: IFCViewerRuntime | null = null;

			// stupidity:allow V6 -- The attachment owns cancellation and teardown for this async lifecycle.
			void (async () => {
				try {
					if (!url) {
						cancelScheduledMarkerVisualization();
						resetSelectionState();
						viewer = null;
						if (!cancelled) loadBanner = 'none';
						return;
					}
					if (!cancelled) loadBanner = 'loading';

					const runtime = await createViewerRuntime(container);
					if (cancelled) {
						await disposeRuntime(runtime);
						return;
					}

					myRuntime = runtime;
					viewer = runtime;
					applyInteractionLock(runtime, interactionLocked);

					await loadIfcModelIntoRuntime(runtime, url);
					if (cancelled) return;

					loadBanner = 'none';
					scheduleMarkerVisualization();
				} catch (error) {
					if (cancelled) return;
					loadBanner = {
						error:
							error instanceof DOMException && error.name === 'AbortError'
								? t('component.ifc_download_timed_out')
								: error instanceof Error
									? getErrorMessage(error)
									: t('component.ifc_load_failed')
					};
					const runtime = myRuntime;
					if (runtime) {
						myRuntime = null;
						if (viewer === runtime) viewer = null;
						await disposeRuntime(runtime);
					}
					console.error('[IFCViewer] Failed to initialize or load IFC viewer.', error);
				}
			})();

			return () => {
				cancelled = true;
				cancelScheduledMarkerVisualization();
				const runtime = myRuntime;
				myRuntime = null;
				if (viewer === runtime) {
					viewer = null;
				}
				if (runtime) void disposeRuntime(runtime);
			};
		};
	}

	const viewerAttach = $derived(viewerAttachment(trimmedSrc));

	async function syncMarkerVisualization(): Promise<void> {
		const runtime = viewer;
		const group = runtime?.currentGroup;
		if (!runtime || !group) return;

		const needsInteraction =
			runtime.markerStyleIds.length > 0 || normalizedMarkerGroups.length > 0 || markers.length > 0;

		if (needsInteraction) {
			ensureInteractionSystems(runtime);
		}

		await clearMarkerVisualization(runtime);

		const highlighter = runtime.highlighter;
		if (highlighter === null) return;

		if (normalizedMarkerGroups.length > 0) {
			// stupidity:allow A6 -- Each style must be registered before its ordered highlighter mutation.
			for (const [index, markerGroup] of normalizedMarkerGroups.entries()) {
				const styleId = `ui-ifc-marker-${index}`;
				highlighter.styles.set(styleId, {
					color: parseMarkerColor(markerGroup.color, runtime.THREE.Color),
					opacity: 1,
					transparent: false,
					renderedFaces: runtime.FRAGS.RenderedFaces.TWO
				});
				runtime.markerStyleIds.push(styleId);
				const fragmentIdMap = { [group.modelId]: new Set(markerGroup.expressIds) };
				await highlighter.highlightByID(styleId, fragmentIdMap, true, false);
			}
			return;
		}

		if (markers.length === 0) return;

		const styleId = 'ui-ifc-markers';
		highlighter.styles.set(styleId, {
			color: new runtime.THREE.Color(resolveCssColor(DEFAULT_SELECTION_COLOR)),
			opacity: 1,
			transparent: false,
			renderedFaces: runtime.FRAGS.RenderedFaces.TWO
		});
		runtime.markerStyleIds.push(styleId);
		const fragmentIdMap = { [group.modelId]: new Set(markers) };
		await highlighter.highlightByID(styleId, fragmentIdMap, true, false);
	}

	async function handlePick(): Promise<void> {
		const runtime = viewer;
		const group = runtime?.currentGroup;
		if (!runtime || !group) return;

		const highlighter = ensureInteractionSystems(runtime);
		await highlighter.highlight('select', true, false);
		if (viewer !== runtime) return;

		const selection = highlighter.selection.select;
		const modelId = Object.keys(selection)[0];
		const id = modelId ? selection[modelId]?.values().next().value : undefined;
		if (modelId == null || id == null) {
			clearSelection();
			return;
		}

		const selectedModel = runtime.fragments.list.get(modelId);
		const properties = selectedModel ? (await selectedModel.getItemsData([id]))[0] : null;
		if (viewer !== runtime) return;

		selectedItem = buildSelectedItem(modelId, id, properties ?? null);
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		void handlePick();
	}

	watch(
		() => interactionLocked,
		(locked) => {
			if (!viewer) return;
			applyInteractionLock(viewer, locked);
		}
	);

	watch(
		() => [markerKey, markerGroupsKey] as const,
		() => {
			scheduleMarkerVisualization();
		}
	);
</script>

<Bound size="standard" clip class="relative rounded-lg border border-border/80 bg-muted/20">
	<div
		class={cn(
			'absolute inset-0 z-0 size-full overscroll-contain border-0 bg-transparent p-0 text-left',
			interactionLocked ? 'touch-pan-y' : 'touch-none'
		)}
		role="button"
		tabindex={0}
		aria-label={alt ?? t('component.ifc_model_preview')}
		onclick={handlePick}
		onkeydown={handleKeydown}
		{@attach viewerAttach}
	></div>

	<Inline align="start" gap="sm" class="pointer-events-none absolute inset-x-0 top-0 z-20 p-3">
		<div class="min-w-0">
			{#if selectedItem}
				{@const item = selectedItem}
				<div
					class="pointer-events-auto w-full max-w-[min(38rem,100%)] rounded-md border border-border/80 bg-background/95 p-2 shadow-sm"
				>
					<button
						type="button"
						class="w-full min-w-0 rounded-sm px-1 py-1 text-left transition-colors hover:bg-muted/60"
						onclick={() => (propertiesOpen = !propertiesOpen)}
					>
						<div class="min-w-0">
							<span class="block truncate text-sm font-medium text-foreground">
								{item.title}
							</span>
							{#if item.subtitle}
								<span class="block truncate text-[11px] text-muted-foreground">
									{item.subtitle}
								</span>
							{:else}
								<span class="block truncate text-[11px] text-muted-foreground">
									{t('component.ifc_element_line', {
										modelId: item.modelId,
										elementId: item.id
									})}
								</span>
							{/if}
						</div>
						<Icon
							icon="lucide:chevron-down"
							class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform {propertiesOpen
								? 'rotate-180'
								: ''}"
						/>
					</button>

					<Button
						size="icon"
						variant="ghost"
						hint={t('component.clear_selected_element')}
						class="shrink-0 self-start"
						onclick={clearSelection}
					>
						<Icon icon="lucide:x" />
					</Button>

					{#if propertiesOpen}
						<!-- stupidity:allow UI11 -- this conditional spacer separates the disclosure card without padding its background -->
						<div class="pt-2">
							<div class="rounded-md border border-border/80 bg-background/95 p-3 shadow-sm">
								<p
									class="pb-2 text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase"
								>
									{t('component.selected_element_properties')}
								</p>
								<Scroll
									axis="both"
									name="Selected element properties"
									class="max-h-80 rounded-md bg-muted/50 p-3 text-[11px] wrap-break-word whitespace-pre-wrap text-muted-foreground"
								>
									<pre>{item.properties}</pre>
								</Scroll>
							</div>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		<Inline align="center" gap="sm" class="pointer-events-auto ml-auto">
			{#if interactionLocked}
				<div
					class="hidden rounded-md border border-border/80 bg-background/90 px-2 py-1 text-[11px] text-muted-foreground shadow-sm sm:block"
				>
					{t('component.scroll_safe_mode')}
				</div>
			{/if}
			<Button
				size="icon"
				variant={interactionLocked ? 'secondary' : 'ghost'}
				aria-pressed={!interactionLocked}
				hint={interactionLocked
					? t('component.unlock_model_navigation')
					: t('component.lock_model_navigation')}
				onclick={toggleInteractionLock}
			>
				<Icon icon={interactionLocked ? 'lucide:lock' : 'lucide:unlock'} />
			</Button>
		</Inline>
	</Inline>

	{#if loadBanner === 'loading'}
		<Inline
			align="center"
			justify="center"
			class="pointer-events-auto absolute inset-0 z-10 bg-background/80 p-4"
		>
			<p class="text-sm text-muted-foreground">{t('component.loading_ifc_model')}</p>
		</Inline>
	{:else if typeof loadBanner === 'object'}
		<Inline
			align="center"
			justify="center"
			class="pointer-events-auto absolute inset-0 z-10 bg-background/85 p-4"
		>
			<p class="max-w-sm text-center text-sm text-destructive">
				{loadBanner.error}
			</p>
		</Inline>
	{:else if !trimmedSrc}
		<Inline align="center" justify="center" class="absolute inset-0 z-10 p-4">
			<p class="text-sm text-muted-foreground">{t('component.no_ifc_model')}</p>
		</Inline>
	{/if}

	{#if normalizedMarkerGroups.length > 0}
		<div
			class="pointer-events-none absolute bottom-2 left-2 z-20 max-w-[min(16rem,85%)] rounded-md border border-border/80 bg-background/90 p-2 shadow-sm"
			aria-label={t('component.marker_legend')}
		>
			<p class="mb-1.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
				{t('component.highlights')}
			</p>
			<Stack as="ul" gap="xs">
				{#each normalizedMarkerGroups as group (group.label + group.color + group.expressIds.join(','))}
					<li>
						<Inline gap="xs" class="text-[11px] text-foreground">
							<span
								class="size-2.5 shrink-0 rounded-sm border border-border/60"
								style={`background-color: ${group.color}`}
								aria-hidden="true"
							></span>
							<span class="min-w-0 truncate">{group.label}</span>
						</Inline>
					</li>
				{/each}
			</Stack>
		</div>
	{/if}
</Bound>
