import type { RemoteQuery } from '@norbital-ai/std/collection';

/**
 * Projects one reactive query without creating a second lifecycle owner.
 *
 * The source still owns loading, errors, refresh, and settlement. This adapter changes only the
 * value a collection facade exposes. Keeping the thenable bridge in a Svelte client module also
 * leaves the Effect-owned runtime free of native Promise control.
 */
class ProjectedRemoteQuery<Source, Value> implements RemoteQuery<Value> {
	readonly #source: RemoteQuery<Source>;
	readonly #projectCurrent: (value: Source) => Value | undefined;
	readonly #projectSettled: (value: Source) => Value;

	constructor(
		source: RemoteQuery<Source>,
		projectCurrent: (value: Source) => Value | undefined,
		projectSettled: (value: Source) => Value
	) {
		this.#source = source;
		this.#projectCurrent = projectCurrent;
		this.#projectSettled = projectSettled;
	}

	get current(): Value | undefined {
		const current = this.#source.current;
		return current === undefined ? undefined : this.#projectCurrent(current);
	}

	get error(): Error | undefined {
		return this.#source.error;
	}

	get loading(): boolean {
		return this.#source.loading;
	}

	refresh = () => this.#source.refresh();

	then = <TResult1 = Value, TResult2 = never>(
		// repository-health:allow EFF2 -- PromiseLike.then requires this callback result shape; the adapter owns no Promise lifecycle and delegates settlement to the source RemoteQuery.
		onfulfilled?: ((value: Value) => TResult1 | PromiseLike<TResult1>) | null,
		// repository-health:allow EFF2 -- PromiseLike.then requires this rejection callback shape; the adapter delegates it directly to the source RemoteQuery.
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
	) => this.#source.then(this.#projectSettled).then(onfulfilled, onrejected);
}

export const projectRemoteQuery = <Source, Value>(
	source: RemoteQuery<Source>,
	projectCurrent: (value: Source) => Value | undefined,
	projectSettled: (value: Source) => Value
): RemoteQuery<Value> => new ProjectedRemoteQuery(source, projectCurrent, projectSettled);
