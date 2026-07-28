<script lang="ts">
	import { cn } from '#lib/utils';
	import type { WithElementRef } from 'bits-ui';
	import { onDestroy } from 'svelte';
	import {
		type CarouselAPI,
		type CarouselProps,
		type EmblaContext,
		setEmblaContext
	} from './context.js';

	let {
		ref = $bindable(null),
		opts = {},
		plugins = [],
		setApi = () => {},
		orientation = 'horizontal',
		class: className,
		children,
		...restProps
	}: WithElementRef<CarouselProps> = $props();

	let carouselState = $state<EmblaContext>({
		api: undefined,
		scrollPrev,
		scrollNext,
		canScrollNext: false,
		canScrollPrev: false,
		handleKeyDown,
		onInit,
		scrollSnaps: [],
		selectedIndex: 0,
		scrollTo,
		// Use getters to ensure reactivity is tracked when accessed
		get orientation() {
			return orientation;
		},
		get options() {
			return opts;
		},
		get plugins() {
			return plugins;
		}
	});

	setEmblaContext(() => carouselState);

	function scrollPrev() {
		carouselState.api?.scrollPrev();
	}
	function scrollNext() {
		carouselState.api?.scrollNext();
	}
	function scrollTo(index: number, jump?: boolean) {
		carouselState.api?.scrollTo(index, jump);
	}

	function onSelect(api: CarouselAPI) {
		if (!api) return;
		carouselState.canScrollPrev = api.canScrollPrev();
		carouselState.canScrollNext = api.canScrollNext();
		carouselState.selectedIndex = api.selectedScrollSnap();
	}

	let attachedApi: CarouselAPI | undefined;

	function attachApi() {
		if (!carouselState.api || carouselState.api === attachedApi) return;
		attachedApi = carouselState.api;
		onSelect(attachedApi);
		attachedApi.on('select', onSelect);
		attachedApi.on('reInit', onSelect);
		setApi(attachedApi);
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			scrollPrev();
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			scrollNext();
		}
	}

	function onInit(event: CustomEvent<CarouselAPI>) {
		carouselState.api = event.detail;

		carouselState.scrollSnaps = carouselState.api.scrollSnapList();
		attachApi();
	}

	onDestroy(() => {
		if (attachedApi) {
			attachedApi.off('select', onSelect);
			attachedApi.off('reInit', onSelect);
		}
	});
</script>

<div
	bind:this={ref}
	data-slot="carousel"
	class={cn('relative', className)}
	role="region"
	aria-roledescription="carousel"
	{...restProps}
>
	{@render children?.()}
</div>
