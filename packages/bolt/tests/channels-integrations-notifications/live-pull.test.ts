import { Effect, Schema } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EffectId } from '@norbital-ai/bolt-protocol';
import { describeIntegrations } from '../../src/authoring/integration-introspection.js';
import {
	collection,
	defineConnection,
	definePull,
	field,
	policy,
	workspace
} from '../../src/authoring/workspace-schema.js';
import { emptyAuthoredRuntime } from '../../src/runtime/collections/authored.js';
import { makeHttpConnectorBinding } from '../../src/runtime/integrations/http-connector.js';
import { Integrations } from '../../src/runtime/integrations/integrations.js';
import { Secrets } from '../../src/runtime/secrets/secrets.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';

/**
 * The pull runtime against four real, public, unauthenticated APIs.
 *
 * Every other test in this suite binds a connector that answers from a literal, which proves the
 * loop's arithmetic and proves nothing about whether the declared paging strategies describe how
 * APIs on the internet actually page. This file is the one that goes out to the network, so it is
 * gated on `BOLT_LIVE_INTEGRATION=1` rather than run by default: a suite that needs pokeapi.co to be
 * up is a suite that goes red for reasons that have nothing to do with the code.
 *
 * The four sources were picked because each one pages a genuinely different way:
 *
 * | source          | strategy      | body shape                      |
 * | --------------- | ------------- | ------------------------------- |
 * | pokeapi.co      | `offset`      | `{ count, next, results: [] }`  |
 * | jsonplaceholder | `link-header` | bare `[]` + RFC 8288 `Link`     |
 * | api.crossref.org| `cursor`      | `{ message: { items, next-cursor } }` |
 * | api.github.com  | none; binding `cursor` | bare `[]`, `?since=` watermark |
 */

const live = process.env['BOLT_LIVE_INTEGRATION'] === '1';

/* -------------------------------------------------------------------------------------------------
 * The authored half — written exactly as a `+integrations.ts` in a collection directory would be.
 * ---------------------------------------------------------------------------------------------- */

const pokeapi = defineConnection({ baseUrl: 'https://pokeapi.co/api/v2' });
const placeholder = defineConnection({ baseUrl: 'https://jsonplaceholder.typicode.com' });
const crossref = defineConnection({ baseUrl: 'https://api.crossref.org' });
const github = defineConnection({ baseUrl: 'https://api.github.com' });
const githubAuthenticated = defineConnection({
	baseUrl: 'https://api.github.com',
	authentication: { type: 'bearer', token: { env: 'GITHUB_TOKEN' } }
});

/** `{ count, next, previous, results: [{ name, url }] }` — verified by curl before this was written. */
const PokemonEntry = Schema.Struct({
	name: Schema.NonEmptyString,
	url: Schema.NonEmptyString
});

/** A bare array of `{ userId, id, title, body }`. */
const Post = Schema.Struct({
	userId: Schema.Number,
	id: Schema.Number,
	title: Schema.NonEmptyString,
	body: Schema.String
});

/**
 * `issue` is deliberately required, and Crossref genuinely does not send it for every work — 17 of
 * 20 in the page this was written against. That is what makes the partial-failure proof honest: the
 * rejected records are records a real source really sent, not junk invented to be rejected.
 */
const Work = Schema.Struct({
	DOI: Schema.NonEmptyString,
	title: Schema.Array(Schema.String),
	publisher: Schema.String,
	issue: Schema.String
});

const Repository = Schema.Struct({
	id: Schema.Number,
	full_name: Schema.NonEmptyString,
	html_url: Schema.String
});

const authoredModule = {
	pokeapi: {
		connection: pokeapi,
		receive: {
			species: definePull({
				pull: {
					schedule: '0 * * * *',
					method: 'GET',
					path: '/pokemon',
					pages: { style: 'offset', offsetQuery: 'offset', limitQuery: 'limit', size: 5, max: 3 }
				},
				input: PokemonEntry,
				records: { field: 'results' },
				identity: { column: 'external_id', value: (entry) => `pokeapi:${entry.name}` },
				map: (entry) => ({ source: 'pokeapi', title: entry.name, detail: entry.url })
			})
		}
	},
	placeholder: {
		connection: placeholder,
		receive: {
			posts: definePull({
				pull: {
					schedule: '0 * * * *',
					method: 'GET',
					path: '/posts',
					// The first page's window is declared query; every page after it is whatever the source's
					// `Link: rel="next"` says, so the runtime never computes a page number of its own.
					query: { _page: '1', _limit: '4' },
					pages: { style: 'link-header', max: 3 }
				},
				input: Post,
				identity: { column: 'external_id', value: (post) => `placeholder:post:${post.id}` },
				map: (post) => ({ source: 'placeholder', title: post.title, detail: post.body })
			})
		}
	},
	crossref: {
		connection: crossref,
		receive: {
			works: definePull({
				pull: {
					schedule: '0 * * * *',
					method: 'GET',
					path: '/works',
					// `cursor=*` is Crossref's "start here". It rides in the declared query because the paging
					// spec has no notion of a first token — page zero simply omits `pages.query`, and the
					// declared query is what fills that hole. Page one onward overwrites it.
					query: {
						rows: '5',
						cursor: '*',
						filter: 'type:journal-article',
						select: 'DOI,title,publisher,issue'
					},
					headers: { 'user-agent': 'bolt-integration-proof/1.0 (mailto:dion.neo@norbital.ai)' },
					pages: {
						style: 'cursor',
						query: 'cursor',
						next: { path: ['message', 'next-cursor'] },
						max: 2
					}
				},
				input: Work,
				records: { path: ['message', 'items'] },
				identity: { column: 'external_id', value: (work) => `crossref:${work.DOI}` },
				map: (work) => ({
					source: 'crossref',
					title: work.title[0] ?? work.DOI,
					detail: work.publisher,
					issue: work.issue
				})
			})
		}
	},
	github: {
		connection: github,
		receive: {
			repositories: definePull({
				pull: {
					schedule: '0 * * * *',
					method: 'GET',
					path: '/repositories',
					// No `pages`: one page per run, and the *binding* cursor is what makes the next run read
					// records this run has not seen. That is incremental sync, and it is a different axis from
					// paging — this binding walks forward one page per scheduled tick, forever.
					cursor: { send: { query: 'since' }, next: { maxOf: 'id' } }
				},
				input: Repository,
				identity: { column: 'external_id', value: (repository) => `github:${repository.id}` },
				map: (repository) => ({
					source: 'github',
					title: repository.full_name,
					detail: repository.html_url
				})
			})
		}
	},
	github_authenticated: {
		connection: githubAuthenticated,
		receive: {
			repositories: definePull({
				pull: {
					schedule: '0 * * * *',
					method: 'GET',
					path: '/repositories',
					query: { per_page: '2' }
				},
				input: Repository,
				identity: { column: 'external_id', value: (repository) => `github-auth:${repository.id}` }
			})
		}
	}
};

const described = describeIntegrations({ external_records: authoredModule });

const definition = workspace({
	name: 'integration-proof',
	version: '1',
	collections: [
		collection({
			name: 'external_records',
			fields: {
				external_id: field.string({ required: true, indexed: true }),
				source: field.string({ required: true, indexed: true }),
				title: field.string(),
				detail: field.string(),
				issue: field.string()
			}
		})
	],
	apps: [],
	policies: [
		policy({ name: 'admin', effect: 'allow', actions: ['*'], apps: ['*'] })
	],
	teams: {
		admin: ['admin']
	},
	agents: [],
	automations: [],
	channels: [],
	integrations: described.declarations,
	requiredFacilities: ['database', 'connector'],
	// The vault refuses to read a name `+env.ts` never declared, and a connection's `{ env }` reference
	// is not that declaration — so an integration's credential needs saying twice, in two files, and
	// nothing checks that the second saying exists until a scheduled pull fails at runtime.
	environment: { variables: { GITHUB_TOKEN: { label: 'GitHub token', secret: true } } }
});

type Row = Readonly<Record<string, unknown>>;

const text_ = (row: Row, column: string): string => {
	const value = row[column];
	return typeof value === 'string' ? value : String(value);
};

let harness: BoltTestRuntime | undefined;

const pull = async (name: string, run: string): Promise<Schema.Json> => {
	if (harness === undefined) throw new Error('harness not built');
	return harness.runtime.runPromise(
		Effect.gen(function* () {
			return yield* (yield* Integrations.Service).pull(EffectId.make(run), name, null);
		})
	);
};

const rows = async (source: string): Promise<ReadonlyArray<Row>> => {
	if (harness === undefined) throw new Error('harness not built');
	return harness.database.query(
		'select external_id, source, title, detail, issue from external_records where source = $1 order by external_id',
		[source]
	);
};

const count = async (source: string): Promise<number> => (await rows(source)).length;

/** The report shape `Integrations.pull` returns, read defensively because it crosses as `Schema.Json`. */
const report = (value: Schema.Json, binding: string): Readonly<Record<string, unknown>> => {
	if (value === null || typeof value !== 'object' || Array.isArray(value))
		throw new Error('report is not an object');
	const bindings = Reflect.get(value, 'bindings');
	if (!Array.isArray(bindings)) throw new Error('report carries no bindings');
	const found = bindings.find(
		(entry) =>
			entry !== null &&
			typeof entry === 'object' &&
			!Array.isArray(entry) &&
			Reflect.get(entry, 'binding') === binding
	);
	if (found === null || found === undefined || typeof found !== 'object' || Array.isArray(found)) {
		throw new Error(`no report for ${binding}: ${JSON.stringify(value)}`);
	}
	return found;
};

const failures = (value: Schema.Json): ReadonlyArray<Schema.Json> => {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
	const list = Reflect.get(value, 'failures');
	return Array.isArray(list) ? list : [];
};

describe.skipIf(!live)('pull runtime against real public APIs', () => {
	beforeAll(async () => {
		harness = await makeBoltTestRuntime(definition, {
			connector: makeHttpConnectorBinding({
				allowedHosts: [
					'pokeapi.co',
					'jsonplaceholder.typicode.com',
					'api.crossref.org',
					'api.github.com'
				]
			}),
			authored: { ...emptyAuthoredRuntime, integrations: described.authored }
		});
	}, 60_000);

	afterAll(async () => {
		await harness?.dispose();
		harness = undefined;
	});

	it('walks pokeapi with offset paging and lands every page as rows', async () => {
		const first = await pull('external_records.pokeapi', 'poke-1');
		expect(failures(first)).toEqual([]);
		const summary = report(first, 'species');
		expect(summary['pages']).toBe(3);
		expect(summary['fetched']).toBe(15);
		expect(summary['created']).toBe(15);
		expect(summary['rejected']).toEqual([]);

		const landed = await rows('pokeapi');
		expect(landed).toHaveLength(15);
		// Page 1 is Pokemon 1-5 and page 3 is 11-15. If the offset never advanced, the loop would have
		// re-read bulbasaur three times and the identity upsert would have quietly collapsed it to five
		// rows — which is exactly what "success" looks like when paging is broken.
		const titles = landed.map((row) => text_(row, 'title'));
		expect(titles).toContain('bulbasaur');
		expect(titles).toContain('metapod');
		expect(new Set(titles).size).toBe(15);
		console.log('[pokeapi rows]', JSON.stringify(landed.slice(0, 3), null, 1));
	}, 60_000);

	it('re-running pokeapi updates the rows it wrote instead of doubling them', async () => {
		const before = await count('pokeapi');
		const second = await pull('external_records.pokeapi', 'poke-2');
		const summary = report(second, 'species');
		expect(summary['fetched']).toBe(15);
		expect(summary['created']).toBe(0);
		expect(summary['updated']).toBe(15);
		expect(await count('pokeapi')).toBe(before);
	}, 60_000);

	it('follows jsonplaceholder through its RFC 8288 Link header', async () => {
		const first = await pull('external_records.placeholder', 'posts-1');
		expect(failures(first)).toEqual([]);
		const summary = report(first, 'posts');
		expect(summary['pages']).toBe(3);
		expect(summary['created']).toBe(12);

		const landed = await rows('placeholder');
		expect(landed).toHaveLength(12);
		const ids = landed.map((row) => text_(row, 'external_id')).toSorted();
		// `Link` sends first, next, last in that order, so a parser that took the first URL would page
		// backwards to page 1 forever and land four rows.
		expect(ids).toContain('placeholder:post:1');
		expect(ids).toContain('placeholder:post:12');
		expect(new Set(ids).size).toBe(12);
		console.log('[placeholder rows]', JSON.stringify(landed.slice(0, 2), null, 1));
	}, 60_000);

	it('walks crossref with a body cursor, through a nested envelope, keeping the records that decode', async () => {
		const first = await pull('external_records.crossref', 'works-1');
		expect(failures(first)).toEqual([]);
		const summary = report(first, 'works');
		expect(summary['pages']).toBe(2);
		expect(summary['fetched']).toBe(10);

		const landed = await rows('crossref');
		// Crossref omits `issue` on some works, and `input` requires it, so some of the ten are rejected
		// and the rest land. Both halves matter: all ten landing would mean the schema is not a gate,
		// and none landing would mean one bad record cost the page.
		const rejected = summary['rejected'];
		expect(Array.isArray(rejected)).toBe(true);
		expect(landed.length).toBeGreaterThan(0);
		expect(landed.length + (Array.isArray(rejected) ? rejected.length : 0)).toBe(10);
		expect(landed.every((row) => text_(row, 'issue') !== 'null')).toBe(true);
		console.log('[crossref rows]', JSON.stringify(landed.slice(0, 3), null, 1));
		console.log('[crossref rejected]', JSON.stringify(rejected, null, 1));
		console.log('[crossref cursor]', JSON.stringify(summary['cursor']));
	}, 90_000);

	it('advances github incrementally: the second run reads repositories the first did not', async () => {
		// `/repositories` ignores `per_page` and always answers 100, which is a useful reminder that a
		// declared page size is a request and not a guarantee.
		const first = await pull('external_records.github', 'repos-1');
		expect(failures(first)).toEqual([]);
		const firstSummary = report(first, 'repositories');
		expect(firstSummary['created']).toBe(100);
		const firstRows = (await rows('github')).map((row) => text_(row, 'external_id'));

		const second = await pull('external_records.github', 'repos-2');
		expect(failures(second)).toEqual([]);
		const secondSummary = report(second, 'repositories');
		console.log('[github summary 1]', JSON.stringify(firstSummary));
		console.log('[github summary 2]', JSON.stringify(secondSummary));
		console.log(
			'[github run 1 max numeric id]',
			Math.max(...firstRows.map((id) => Number(id.split(':')[1])))
		);
		// The whole point: `?since=<max id seen>` means run two asks for a window run one never read, so
		// every row is new. A cursor that failed to persist would re-read the same 100 and update them.
		expect(secondSummary['created']).toBe(100);
		expect(secondSummary['updated']).toBe(0);

		const allRows = (await rows('github')).map((row) => text_(row, 'external_id'));
		expect(allRows).toHaveLength(200);
		expect(allRows.filter((id) => firstRows.includes(id))).toHaveLength(100);
		console.log('[github run 1]', JSON.stringify(firstRows));
		console.log('[github run 2]', JSON.stringify(allRows.filter((id) => !firstRows.includes(id))));
		console.log(
			'[github cursor]',
			JSON.stringify(firstSummary['cursor']),
			'->',
			JSON.stringify(secondSummary['cursor'])
		);
	}, 90_000);

	it('resolves a declared bearer credential out of the vault and puts it on the wire', async () => {
		if (harness === undefined) throw new Error('harness not built');
		// No value in the vault yet: the pull must refuse by name rather than silently send no header.
		const unset = await pull('external_records.github_authenticated', 'auth-0');
		expect(JSON.stringify(failures(unset))).toContain('GITHUB_TOKEN');

		await harness.runtime.runPromise(
			Effect.gen(function* () {
				yield* (yield* Secrets.Service).write(
					EffectId.make('vault-1'),
					'GITHUB_TOKEN',
					'not-a-real-token',
					'proof'
				);
			})
		);
		const wrong = await pull('external_records.github_authenticated', 'auth-1');
		const reason = JSON.stringify(failures(wrong));
		// GitHub can only answer 401 if it received an Authorization header — unauthenticated, the same
		// request is a 200. So a 401 is the positive proof that the vault value reached the wire.
		expect(reason).toContain('401');
		expect(await count('github-auth')).toBe(0);
		console.log('[auth unset]', JSON.stringify(failures(unset)));
		console.log('[auth wrong]', reason);
	}, 60_000);
});
