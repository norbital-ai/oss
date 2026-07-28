import { createContext } from 'svelte';

const [getTimelineContext, setTimelineContext] = createContext<() => TimelineContext>();
export { getTimelineContext, setTimelineContext };

export class TimelineContext {
	#isOpen = $state(false);
	#onOpenChange: ((open: boolean) => void) | undefined;

	constructor(
		options: {
			isOpen?: boolean;
			onOpenChange?: (open: boolean) => void;
		} = {}
	) {
		this.#isOpen = options.isOpen ?? false;
		this.#onOpenChange = options.onOpenChange;
	}

	get isOpen() {
		return this.#isOpen;
	}

	set isOpen(value: boolean) {
		this.#isOpen = value;
		this.#onOpenChange?.(value);
	}

	setIsOpen = (open: boolean) => {
		this.isOpen = open;
	};

	toggle() {
		this.isOpen = !this.isOpen;
	}
}
