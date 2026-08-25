/**
 * Turning a user's `provider` configuration into a resolved `Embedder`.
 *
 * The registry is deliberately a plain record of factories rather than a class hierarchy or a
 * switch: adding a provider means adding one entry and one module, and the error for an unknown
 * name can list the names that do exist. Only `openrouter` ships today, but the shape anticipates
 * the second provider so nobody redesigns this file under deadline.
 *
 * Credentials are referenced by environment-variable *name*, never by value: configs are committed
 * files, keys are not. A function provider closes over whatever it needs and skips the lookup
 * entirely — it is the escape hatch for local models and tests, and its id records the function's
 * name plus the declared dimensionality because those two facts are all that distinguishes one
 * custom vector space from another.
 */
import type { Embedder, EmbedKind } from '../embedder.js';
import { createOpenRouterEmbedder } from './openrouter.js';

/** An inline embed function: raw texts in (no query prefix applied), one row of numbers per text. */
type InlineEmbedFn = (
	texts: ReadonlyArray<string>,
	kind: EmbedKind
) => Promise<Array<Array<number>>>;

type EmbedderConfig = Readonly<{
	/** A named built-in provider (unknown names throw with the known list), or an inline function. */
	readonly provider: string | InlineEmbedFn;
	readonly model?: string | undefined;
	/**
	 * Vector width. Built-ins default to their model's native size; a function provider must
	 * declare it, because nothing else can know before the first call and the index manifest
	 * needs it up front.
	 */
	readonly dimensions?: number | undefined;
	/** Name of the environment variable holding the API key. Default `NORBITAL_AI_CREDENTIAL`. */
	readonly credential?: string | undefined;
	readonly endpoint?: string | undefined;
}>;

const DEFAULT_CREDENTIAL = 'NORBITAL_AI_CREDENTIAL';

const wrapInline = (provider: InlineEmbedFn, dimensions: number): Embedder => {
	const id = `custom:${provider.name || 'anonymous'}:${dimensions}`;
	return Object.freeze({
		id,
		dimensions,
		embed: async (
			texts: ReadonlyArray<string>,
			kind: EmbedKind
		): Promise<Array<Float32Array>> => {
			const rows = await provider(texts, kind);
			if (!Array.isArray(rows) || rows.length !== texts.length)
				throw new Error(
					`norbital-doctor: custom embed provider returned ${rows.length} rows for ${texts.length} texts`
				);
			return rows.map((row, index) => {
				if (!Array.isArray(row) || row.length !== dimensions)
					throw new Error(
						`norbital-doctor: custom embed provider returned ${row.length} dimensions for text ${index}, declared ${dimensions}`
					);
				const vector = new Float32Array(dimensions);
				for (const [slot, value] of row.entries()) {
					if (typeof value !== 'number' || !Number.isFinite(value))
						throw new Error(
							`norbital-doctor: custom embed provider returned a non-finite value for text ${index}`
						);
					vector[slot] = value;
				}
				return vector;
			});
		}
	});
};

type ProviderFactory = (config: EmbedderConfig) => Embedder;

/** Named providers, keyed by the string a config writes. New names slot in beside `openrouter`. */
const FACTORIES: Readonly<Record<string, ProviderFactory>> = {
	openrouter: (config) => {
		const credentialName = config.credential ?? DEFAULT_CREDENTIAL;
		const apiKey = process.env[credentialName];
		if (apiKey === undefined || apiKey === '')
			throw new Error(
				`set ${credentialName} (an openrouter API key) to run the semantic tier`
			);
		return createOpenRouterEmbedder({
			apiKey,
			model: config.model,
			dimensions: config.dimensions,
			endpoint: config.endpoint
		});
	}
};

/** Resolve whichever provider a config names into a usable embedder, failing loudly and early. */
export function resolveEmbedder(config: EmbedderConfig): Embedder {
	if (typeof config.provider === 'function') {
		if (
			config.dimensions === undefined ||
			!Number.isInteger(config.dimensions) ||
			config.dimensions <= 0
		)
			throw new Error(
				'declare dimensions for a function embed provider; they cannot be known before the first call'
			);
		return wrapInline(config.provider, config.dimensions);
	}
	const factory = FACTORIES[config.provider];
	if (factory === undefined)
		throw new Error(
			`unknown embed provider "${config.provider}"; known providers are ${Object.keys(FACTORIES).join(', ')}`
		);
	return factory(config);
}
