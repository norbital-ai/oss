import { Predicate, Schema } from 'effect';
import { attached } from '../body.ts';
import type { BodyReturn, PageReadContext } from '../ctx.ts';
import type { Json } from '../values.ts';

/** The requested URL within this workspace; transport headers and credentials stay with the host. */
export interface PageLoadRequest {
	readonly pathname: string;
	readonly search: string;
}

/** A public page reads as its admitted caller and returns data described by its shared codec. */
export type PageLoad<D> = (request: PageLoadRequest, ctx: PageReadContext) => BodyReturn<D>;

/** A public page's shared data codec and caller-scoped server loader. */
export interface PageServer<out D> {
	readonly data: Schema.Codec<D, Json>;
	readonly load: PageLoad<D>;
}

/** The decoded data passed to a page's Svelte component during server rendering and hydration. */
export type PageData<P extends { readonly data: Schema.Top }> = P['data']['Type'];

/**
 * `+<page>.page.server.ts`: a read-only server loader beside `+<page>.page.svelte`.
 * Import the default codec from the ordinary `<page>.page.data.ts` helper in both files; the
 * browser never imports this server declaration. Evaluation attaches the loader without running it.
 */
export function pageServer<D>(spec: {
	readonly data: Schema.Codec<D, Json>;
	readonly load: PageLoad<NoInfer<D>>;
}): PageServer<D> {
	return { data: spec.data, load: attached(spec.load, 1) };
}

/** The compiler's canonical metadata; neither declaration evaluation path executes the loader. */
export function pageServerMetadata(
	declaration: unknown,
	sharedCodec: unknown
): {
	readonly data: true;
	readonly load: true;
} {
	if (
		!Predicate.isObject(declaration) ||
		!Schema.isSchema(declaration['data']) ||
		typeof declaration['load'] !== 'function'
	)
		throw new Error('a page server declares its shared data codec and generator load body');
	if (declaration['data'] !== sharedCodec)
		throw new Error('a page server must use its shared page.data.ts codec');
	const original: unknown =
		Object.getOwnPropertyDescriptor(declaration['load'], Symbol.for('norbital.bolt.generator'))
			?.value ?? declaration['load'];
	if (Object.prototype.toString.call(original) !== '[object GeneratorFunction]')
		throw new Error('a page server load body must be a generator function');
	return { data: true, load: true };
}
