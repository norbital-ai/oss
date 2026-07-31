import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NorbitalManifestSchema } from '@norbital-ai/platform-utils/manifest/types';
import { defineModel, text } from '../../src/lib/authoring/index.js';
import {
	defineModels,
	defineRuntimeCollection,
	defineRuntimeRegistry
} from '../../src/lib/authoring/filesystem.js';
import { defineRuntimeWorkspace } from '../../src/lib/authoring/workspace/define-workspace.js';
import {
	defineConnection,
	type HttpConnection
} from '../../src/lib/authoring/integrations/integrations.js';
import { buildNorbitalManifest } from '../../src/lib/manifest/index.js';

const connection = () =>
	defineConnection({
		baseUrl: 'https://api.example.test',
		authentication: { type: 'bearer', token: { env: 'REGISTRY_KEY' } }
	});

const PRIVATE_ENV = { REGISTRY_KEY: { description: 'Registry API key' } };

/** The minimum a collection needs to be allowed to send and receive: both pipelines. */
const PIPELINES = {
	export: { handler: async () => [] },
	import: { input: z.unknown(), handler: async () => [] }
};

/**
 * Assembled the way the compiler assembles a real workspace — models, registry, runtime collections —
 * so the connection travels through the same path a `+integrations.ts` file does.
 */
function workspace(options: {
	readonly quotes?: Record<string, unknown>;
	readonly invoices?: Record<string, unknown>;
	readonly env?: { readonly private?: Record<string, { readonly description: string }> };
}) {
	const models = defineModels({
		quotes: defineModel({ title: text() }, { recordLabel: 'title' }),
		invoices: defineModel({ title: text() }, { recordLabel: 'title' })
	});
	const registry = defineRuntimeRegistry({ models, relationships: () => ({}) });
	return defineRuntimeWorkspace(registry, {
		collections: [
			defineRuntimeCollection(registry, 'quotes', [
				PIPELINES,
				...(options.quotes ? [{ integrations: options.quotes }] : [])
			]),
			defineRuntimeCollection(registry, 'invoices', [
				PIPELINES,
				...(options.invoices ? [{ integrations: options.invoices }] : [])
			])
		],
		...(options.env ? { env: options.env } : {})
	});
}

const sendBinding = (conn: HttpConnection, path: string) => ({
	registry: {
		connection: conn,
		send: { upsert: { request: { method: 'POST', path }, on: 'create' } }
	}
});

/**
 * A connection used to be accepted only if it was the very same *object* as one in `defineWorkspace`'s
 * `connections` input, which the compiler never emitted. Two collections in two files cannot share an
 * object without a third file to hold it, so an HTTP destination could not be built from the
 * filesystem at all.
 */
describe('a connection declared in +integrations.ts', () => {
	it('builds an HTTP destination with the credential as a reference', () => {
		const ws = workspace({
			quotes: sendBinding(connection(), '/quotes'),
			env: { private: PRIVATE_ENV }
		});
		const definition = ws.integrations[0]?.definition as {
			connection: { authentication: { token: unknown } };
			outbound: Record<string, { destination: Record<string, unknown> }>;
		};
		expect(definition.connection.authentication.token).toEqual({
			type: 'secret',
			name: 'REGISTRY_KEY'
		});
		expect(definition.outbound['quotes.send.upsert']?.destination).toMatchObject({
			type: 'api',
			url: 'https://api.example.test/quotes',
			method: 'POST',
			secretHeaders: {
				authorization: { type: 'secret', name: 'REGISTRY_KEY', prefix: 'Bearer ' }
			}
		});
	});

	/**
	 * The bearer prefix used to travel as a parallel `secretHeaderPrefixes` map, which the strict
	 * manifest schema rejects — so no connection could ever have produced a valid manifest, even one
	 * written by hand.
	 */
	it('produces a manifest the strict schema accepts', () => {
		const ws = workspace({
			quotes: sendBinding(connection(), '/quotes'),
			env: { private: PRIVATE_ENV }
		});
		const built = buildNorbitalManifest({
			collections: {},
			secrets: ws.secrets,
			integrations: ws.integrations
		});
		const parsed = NorbitalManifestSchema.safeParse(built);
		expect(parsed.error?.message ?? 'ok').toBe('ok');
	});

	it('lets two collections share one integration by writing the same connection twice', () => {
		expect(() =>
			workspace({
				quotes: sendBinding(connection(), '/quotes'),
				invoices: sendBinding(connection(), '/invoices'),
				env: { private: PRIVATE_ENV }
			})
		).not.toThrow();
	});

	it('still refuses two collections that disagree about where the integration points', () => {
		expect(() =>
			workspace({
				quotes: sendBinding(connection(), '/quotes'),
				invoices: sendBinding(defineConnection({ baseUrl: 'https://elsewhere.test' }), '/invoices'),
				env: { private: PRIVATE_ENV }
			})
		).toThrow(/same connection across collections/);
	});
});

/** Both directions are checked, so a reference and its declaration cannot drift apart silently. */
describe('private environment declarations', () => {
	it('refuses a reference to a name src/+env.ts does not declare', () => {
		expect(() => workspace({ quotes: sendBinding(connection(), '/quotes') })).toThrow(
			/undeclared private environment key "REGISTRY_KEY".*src\/\+env\.ts/s
		);
	});

	it('refuses a declared name nothing references', () => {
		expect(() =>
			workspace({
				quotes: sendBinding(connection(), '/quotes'),
				env: { private: { ...PRIVATE_ENV, UNUSED_KEY: { description: 'nothing reads this' } } }
			})
		).toThrow(/nothing references: UNUSED_KEY/);
	});
});
