import { PersistedState } from 'runed';

export class CollectionDetailPreferences {
	readonly #fullScreenByCollection = new PersistedState<Record<string, boolean>>(
		'collection-detail:full-screen',
		{}
	);

	isFullScreen(collectionName: string): boolean {
		return this.#fullScreenByCollection.current[collectionName] ?? false;
	}

	toggleFullScreen(collectionName: string): void {
		this.#fullScreenByCollection.current = {
			...this.#fullScreenByCollection.current,
			[collectionName]: !this.isFullScreen(collectionName)
		};
	}
}
