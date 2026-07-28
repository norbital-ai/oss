import { createContext } from 'svelte';
import { DocTocAnchorObserver } from './anchor-observer';
import type { DocTocItem, DocTocItemInfo } from './types';

export class DocTocState {
	readonly observer = new DocTocAnchorObserver();
	items = $state<DocTocItem[]>([]);
	observedItems = $state<DocTocItemInfo[]>([]);

	constructor() {
		this.observer.listen((next) => {
			this.observedItems = next;
		});
	}

	setItems(next: DocTocItem[]): void {
		this.items = next;
		this.observer.setItems(next);
	}
}

export const [getDocTocState, setDocTocStateContext] = createContext<() => DocTocState>();

export function setDocTocState(state: DocTocState): DocTocState {
	setDocTocStateContext(() => state);
	return state;
}
