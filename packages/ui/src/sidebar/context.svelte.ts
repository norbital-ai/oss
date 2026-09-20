import { createContext } from 'svelte';
import { narrowViewport } from '#lib/utils/viewport.svelte';
import { SIDEBAR_KEYBOARD_SHORTCUT } from '#lib/sidebar/constants';

type Getter<T> = () => T;

type SidebarStateProps = {
	/**
	 * A getter function that returns the current open state of the sidebar.
	 * We use a getter function here to support `bind:open` on the `Sidebar.Provider`
	 * component.
	 */
	open: Getter<boolean>;

	/**
	 * A function that sets the open state of the sidebar. To support `bind:open`, we need
	 * a source of truth for changing the open state to ensure it will be synced throughout
	 * the sub-components and any `bind:` references.
	 */
	setOpen: (open: boolean) => void;
};

class SidebarState {
	readonly props: SidebarStateProps;
	open = $derived.by(() => this.props.open());
	openMobile = $state(false);
	setOpen: SidebarStateProps['setOpen'];
	state = $derived.by(() => (this.open ? 'expanded' : 'collapsed'));

	constructor(props: SidebarStateProps) {
		this.setOpen = props.setOpen;
		this.props = props;
	}

	/** Narrow is the one width question; `utils/viewport` owns it so every surface agrees. */
	get isMobile() {
		return narrowViewport.current;
	}

	// Event handler to apply to the `<svelte:window>`
	handleShortcutKeydown = (e: KeyboardEvent) => {
		if (e.key === SIDEBAR_KEYBOARD_SHORTCUT && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			this.toggle();
		}
	};

	setOpenMobile = (value: boolean) => {
		this.openMobile = value;
	};

	toggleExpansion = () => {
		if (this.isMobile) {
			this.openMobile = false;
			return;
		}
		this.setOpen(!this.open);
	};

	toggle = () => {
		return this.isMobile ? (this.openMobile = !this.openMobile) : this.setOpen(!this.open);
	};
}

export const [useSidebar, setSidebarContext] = createContext<() => SidebarState>();

/**
 * Instantiates a new `SidebarState` instance and sets it in the context.
 *
 * @param props The constructor props for the `SidebarState` class.
 * @returns  The `SidebarState` instance.
 */
export function setSidebar(props: SidebarStateProps): SidebarState {
	const sidebarState = new SidebarState(props);
	setSidebarContext(() => sidebarState);
	return sidebarState;
}

