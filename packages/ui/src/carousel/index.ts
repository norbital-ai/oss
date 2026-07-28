import Root from './carousel.svelte';
import Content from './carousel-content.svelte';
import Item from './carousel-item.svelte';
import CarouselButton from './carousel-button.svelte';

export {
	Root,
	Content,
	Item,
	CarouselButton as Previous,
	CarouselButton as Next,
	Root as Carousel,
	Content as CarouselContent,
	Item as CarouselItem,
	CarouselButton as CarouselPrevious,
	CarouselButton as CarouselNext
};

export { default as SlidesCarousel } from './slides-carousel.svelte';
