import { Effect, Schema } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { EffectId, type ConnectorRequest, type ConnectorResponse, type FacilityBinding } from '@norbital-ai/bolt-protocol';
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
import { Integrations } from '../../src/runtime/integrations/integrations.js';
import { makeBoltTestRuntime, type BoltTestRuntime } from '../support/bolt-test-layer.js';

/**
 * An inbound record carrying a foreign *code* becoming a row carrying a `uuid` foreign key.
 *
 * This is the case that deleted an integration. `map` was `(record) => Row` — pure, synchronous, no
 * `api`, no Effect — so a delivery naming its site as `"SITE-A"` had no way to become a `site_id`,
 * and the field-operations `jobs` webhook was removed rather than written wrong.
 *
 * The lift is a **per-batch** `resolve`, not a per-record `api`, and the arithmetic is the reason.
 * A lookup per record is a round trip per record: at roughly 250ms each, a 5,000-row import spends
 * about twenty minutes waiting for one foreign key, and twice that for two. The same import through
 * a batch step spends one query per page. A per-record `api` would read fine in every example an
 * author writes and be unusable at the size the feature exists for, which is the definition of a
 * footgun — so `resolve` runs once, holds the `api`, and hands `map` what it found.
 *
 * The four facts below are what has to be true for that to be worth having.
 */

/* -------------------------------------------------------------------------------------------------
 * The authored half — written exactly as a `+integrations.ts` in a collection directory would be.
 * ---------------------------------------------------------------------------------------------- */

const dispatch = defineConnection({ baseUrl: 'https://dispatch.example/api' });

/** One job as the dispatch system sends it: it names its site by *code*, never by our id. */
const DispatchedJob = Schema.Struct({
	reference: Schema.NonEmptyString,
	site_code: Schema.NonEmptyString,
	title: Schema.NonEmptyString
});

/** One site as a plain feed sends it — the pure-`map` binding, unchanged by any of this. */
const SiteRecord = Schema.Struct({
	code: Schema.NonEmptyString,
	name: Schema.NonEmptyString
});

/**
 * Reads `norbital_id` off a row the api answered with.
 *
 * The api's rows carry `& Readonly<Record<string, unknown>>`, so a column read is `unknown` and has
 * to be narrowed. A workspace's own generated types name the columns; this suite has no workspace
 * declaration merged in, which is exactly why the field-operations template is the other half of
 * this proof — it is where the typed `where` and the typed row are checked.
 */
const columnOf = (row: Readonly<Record<string, unknown>>, column: string): string | undefined => {
	const value = row[column];
	return typeof value === 'string' ? value : undefined;
};

const jobsModule = {
	dispatch: {
		connection: dispatch,
		receive: {
			job_updated: definePull({
				pull: { schedule: '*/5 * * * *', method: 'GET', path: '/jobs/changed' },
				records: { field: 'jobs' },
				input: DispatchedJob,
				identity: { column: 'external_ref', value: (job) => job.reference },
				/**
				 * One query for the batch, whatever the batch's size.
				 *
				 * `records` is every job that decoded and produced an identity, so the codes can be
				 * gathered and asked for together. A template with its own generated types filters this
				 * with `where: { site_code: { in: codes } }`; this suite has no schema merged in, so it
				 * reads the table and indexes it here. Either way it is *one* statement per batch, which
				 * is the property under test.
				 */
				resolve: ({ records, api }) =>
					Effect.gen(function* () {
						const wanted = new Set(records.map((job) => job.site_code));
						const sites = yield* api.db.query.sites.findMany();
						const byCode = new Map<string, string>();
						for (const site of sites) {
							const code = columnOf(site, 'site_code');
							const id = columnOf(site, 'norbital_id');
							if (code !== undefined && id !== undefined && wanted.has(code)) byCode.set(code, id);
						}
						return byCode;
					}),
				map: (job, sites) => {
					const siteId = sites.get(job.site_code);
					// Thrown rather than defaulted, and thrown *here* rather than reported by `resolve`:
					// this is a fact about one record, so it must cost one record. The platform catches it
					// per record and writes the job's siblings exactly as if this one had not been sent.
					if (siteId === undefined) {
						throw new Error(`job ${job.reference} names site ${job.site_code}, which this workspace does not have`);
					}
					return { external_ref: job.reference, site_id: siteId, title: job.title };
				}
			})
		}
	}
};

/** The unchanged shape: a pure `(record) => Row`, no `resolve` anywhere near it. */
const sitesModule = {
	registry: {
		connection: dispatch,
		receive: {
			sites_changed: definePull({
				pull: { schedule: '0 * * * *', method: 'GET', path: '/sites/changed' },
				records: { field: 'sites' },
				input: SiteRecord,
				identity: { column: 'site_code', value: (site) => site.code },
				map: (site) => ({ site_code: site.code, name: site.name })
			})
		}
	}
};

const described = describeIntegrations({ jobs: jobsModule, sites: sitesModule });

const definition = workspace({
	name: 'foreign-key-resolution',
	version: '1',
	collections: [
		collection({
			name: 'sites',
			fields: {
				site_code: field.string({ required: true, indexed: true }),
				name: field.string({ required: true })
			}
		}),
		collection({
			name: 'jobs',
			fields: {
				external_ref: field.string({ required: true, indexed: true }),
				// A real `uuid` column rather than a string that looks like one. It is what makes "the
				// resolved id landed" a claim the database checks: a code written through unresolved
				// would not be a uuid, and the insert would be refused rather than stored.
				site_id: { type: 'uuid', required: true, indexed: true },
				title: field.string({ required: true })
			}
		})
	],
	apps: [],
	policies: [policy({ name: 'admin', effect: 'allow', actions: ['*'], roles: ['admin'], apps: ['*'] })],
	agents: [],
	automations: [],
	channels: [],
	integrations: described.declarations,
	requiredFacilities: ['database', 'connector']
});

/* -------------------------------------------------------------------------------------------------
 * The host half.
 * ---------------------------------------------------------------------------------------------- */

/** A connector that answers one scripted body and records nothing else. */
const answering = (body: Schema.Json): FacilityBinding<ConnectorRequest, ConnectorResponse> => ({
	call: async () => ({ _tag: 'Success', value: { output: { status: 200, headers: {}, body } } })
});

let harness: BoltTestRuntime | undefined;

afterEach(async () => {
	await harness?.dispose();
	harness = undefined;
});

const build = async (body: Schema.Json): Promise<BoltTestRuntime> => {
	const built = await makeBoltTestRuntime(definition, {
		connector: answering(body),
		authored: { ...emptyAuthoredRuntime, integrations: described.authored }
	});
	harness = built;
	return built;
};

/** The two sites this workspace knows about, inserted the way any other row would be. */
const seedSites = async (built: BoltTestRuntime): Promise<Readonly<Record<string, string>>> => {
	const rows = await built.database.query(
		"insert into sites (site_code, name) values ('SITE-A', 'Alpha'), ('SITE-B', 'Bravo') returning site_code, norbital_id",
		[]
	);
	return Object.fromEntries(rows.map((row) => [String(row['site_code']), String(row['norbital_id'])]));
};

const pull = (built: BoltTestRuntime, integration: string, binding: string, run: string) =>
	built.runtime.runPromise(
		Effect.flatMap(Integrations.Service, (integrations) =>
			integrations.pull(EffectId.make(run), integration, null, binding)
		)
	);

/** The report crosses as `Schema.Json`, so it is read the way a host would have to read it. */
const at = (value: Schema.Json, key: string): unknown =>
	value === null || typeof value !== 'object' || Array.isArray(value) ? undefined : Reflect.get(value, key);

/** The one binding's own report, which is where the counts and the rejections live. */
const bindingReport = (report: Schema.Json): Schema.Json => {
	const bindings = at(report, 'bindings');
	const first = Array.isArray(bindings) ? bindings[0] : undefined;
	if (first === undefined) throw new Error(`the run reported no binding: ${JSON.stringify(report)}`);
	return first;
};

/** Rows written, whether the write was an insert or an update of the row a previous run made. */
const absorbed = (report: Schema.Json): number => {
	const binding = bindingReport(report);
	return Number(at(binding, 'created')) + Number(at(binding, 'updated'));
};

const rejections = (report: Schema.Json): ReadonlyArray<Readonly<Record<string, unknown>>> => {
	const listed = at(bindingReport(report), 'rejected');
	return Array.isArray(listed)
		? listed.flatMap((entry) =>
				entry !== null && typeof entry === 'object' && !Array.isArray(entry)
					? [entry as Readonly<Record<string, unknown>>]
					: []
			)
		: [];
};

/** How many statements this run ran against `sites` — the round-trip count the design turns on. */
const siteQueries = (built: BoltTestRuntime): number =>
	built.database.statements.filter((sql) => /\bfrom\s+"?sites"?/i.test(sql)).length;

const jobsFor = (codes: ReadonlyArray<string>): Schema.Json => ({
	jobs: codes.map((code, index) => ({
		reference: `JOB-${index + 1}`,
		site_code: code,
		title: `Job ${index + 1}`
	}))
});

/* -------------------------------------------------------------------------------------------------
 * The proofs.
 * ---------------------------------------------------------------------------------------------- */

describe('an inbound record carrying a foreign code lands with a resolved uuid foreign key', () => {
	/**
	 * The assertion is on the stored row, not on what a function returned. `site_id` is a `uuid`
	 * column and the value asserted is the id the seeded site actually has, so this fails both if the
	 * resolution never happened and if it happened and produced the wrong site.
	 */
	it('writes the site id the code named, read out of the collection', async () => {
		const built = await build(jobsFor(['SITE-A', 'SITE-B']));
		const sites = await seedSites(built);
		const report = await pull(built, 'jobs.dispatch', 'job_updated', 'run-1');

		expect(absorbed(report)).toBe(2);
		const stored = await built.database.query(
			'select external_ref, site_id, title from jobs order by external_ref',
			[]
		);
		expect(stored).toEqual([
			{ external_ref: 'JOB-1', site_id: sites['SITE-A'], title: 'Job 1' },
			{ external_ref: 'JOB-2', site_id: sites['SITE-B'], title: 'Job 2' }
		]);
	});

	/**
	 * And the identity discipline is untouched by any of it. The external key in the row is the one
	 * the declared `identity` read, so a second delivery of the same job updates the row the first
	 * one wrote rather than inserting a second — the property `resolve` must not be allowed to cost.
	 */
	it('still stamps the identity column from the declared identity, so a re-run updates in place', async () => {
		const built = await build(jobsFor(['SITE-A']));
		await seedSites(built);
		await pull(built, 'jobs.dispatch', 'job_updated', 'run-1');
		await pull(built, 'jobs.dispatch', 'job_updated', 'run-2');
		const stored = await built.database.query('select external_ref from jobs', []);
		expect(stored).toEqual([{ external_ref: 'JOB-1' }]);
	});
});

describe('a code that resolves to nothing costs that record and nothing else', () => {
	/**
	 * The refusal has to be per record. A batch-level failure here would be the worse behaviour twice
	 * over: the two good jobs would be lost, and a pull's cursor would either stall on one bad row
	 * forever or advance past the good ones.
	 */
	it('rejects the unresolvable record, writes its siblings, and says which code was missing', async () => {
		const built = await build(jobsFor(['SITE-A', 'SITE-GHOST', 'SITE-B']));
		const sites = await seedSites(built);
		const report = await pull(built, 'jobs.dispatch', 'job_updated', 'run-1');

		expect(absorbed(report)).toBe(2);
		const stored = await built.database.query('select external_ref, site_id from jobs order by external_ref', []);
		expect(stored).toEqual([
			{ external_ref: 'JOB-1', site_id: sites['SITE-A'] },
			{ external_ref: 'JOB-3', site_id: sites['SITE-B'] }
		]);

		const refused = rejections(report);
		expect(refused).toHaveLength(1);
		expect(refused[0]?.['index']).toBe(1);
		expect(String(refused[0]?.['reason'])).toContain('SITE-GHOST');
	});
});

describe('the batch costs one lookup, not one per record', () => {
	/**
	 * The whole design justification, asserted as a count rather than described in a comment. Twenty
	 * five records that all need a foreign key resolved must produce exactly one statement against
	 * `sites`; a per-record `api` would produce twenty five, and at a real round trip that is the
	 * difference between a page and a coffee break.
	 */
	it('issues exactly one statement against the resolved collection for a batch of twenty five', async () => {
		const codes = Array.from({ length: 25 }, (_, index) => (index % 2 === 0 ? 'SITE-A' : 'SITE-B'));
		const built = await build(jobsFor(codes));
		await seedSites(built);
		built.database.forget();

		const report = await pull(built, 'jobs.dispatch', 'job_updated', 'run-1');
		expect(absorbed(report)).toBe(25);
		expect(siteQueries(built)).toBe(1);
	});

	/**
	 * And a binding that declares no `resolve` pays for none. The step is skipped rather than run
	 * with an empty answer, so the shape costs nothing to the bindings that do not use it.
	 */
	it('runs no lookup at all for a binding that declares no resolve', async () => {
		const built = await build({ sites: [{ code: 'SITE-C', name: 'Charlie' }] });
		built.database.forget();
		await pull(built, 'sites.registry', 'sites_changed', 'run-1');
		// One `select` remains: the identity read that finds which external keys already exist. That is
		// the upsert's own lookup and it was always there; what must not appear is a second one.
		expect(siteQueries(built)).toBe(1);
	});
});

describe('resolve failing is the batch\'s problem, not a record\'s', () => {
	/**
	 * The one case that is deliberately *not* a per-record rejection. A lookup that could not run at
	 * all — a database that will not answer, an authored step that threw — is not attributable to any
	 * record in the batch, and rejecting all of them would advance a pull's cursor past a window
	 * nothing was written for. Failing the binding leaves the cursor where it was, so the next
	 * scheduled run reads the same window again.
	 */
	it('fails the binding, leaves the cursor alone, and names the integration in the reason', async () => {
		const built = await build(jobsFor(['SITE-A', 'SITE-B']));
		await seedSites(built);
		await built.database.query('drop table sites cascade', []);

		const report = await pull(built, 'jobs.dispatch', 'job_updated', 'run-1');
		const failures = at(report, 'failures');
		expect(Array.isArray(failures) ? failures.length : 0).toBe(1);
		const first = Array.isArray(failures) ? (failures[0] as Schema.Json) : null;
		expect(String(at(first, 'reason'))).toContain('jobs.dispatch failed to resolve a batch');
		// Nothing partial was written, and no rejection was recorded against a record that did nothing.
		const stored = await built.database.query('select external_ref from jobs', []);
		expect(stored).toEqual([]);
	});
});

describe('a resolve nothing reads is refused where the workspace is compiled', () => {
	/**
	 * A `resolve` with no `map` is a query per batch that changes no row. It is almost always a `map`
	 * the author has not written yet, and the alternative to refusing it is a binding that quietly
	 * does the work and throws the answer away.
	 */
	it('refuses a binding that declares a resolve and no map', () => {
		expect(() =>
			describeIntegrations({
				jobs: {
					dispatch: {
						connection: dispatch,
						receive: {
							job_updated: {
								pull: { schedule: '0 * * * *', method: 'GET', path: '/jobs' },
								input: DispatchedJob,
								identity: { column: 'external_ref', value: (job: { readonly reference: string }) => job.reference },
								resolve: () => new Map<string, string>()
							}
						}
					}
				}
			})
		).toThrow(/declares a resolve but no map/);
	});
});

describe('a pure map still works exactly as it did', () => {
	/**
	 * Every `map` in `templates/crm` is `(record) => Row` and none of them was touched. A one-argument
	 * closure called with two arguments ignores the second, and the binding behaves identically — this
	 * is the guarantee that made changing the signature acceptable rather than a migration.
	 */
	it('imports through a one-argument map that never hears about the resolution', async () => {
		const built = await build({ sites: [{ code: 'SITE-C', name: 'Charlie' }, { code: 'SITE-D', name: 'Delta' }] });
		const report = await pull(built, 'sites.registry', 'sites_changed', 'run-1');
		expect(absorbed(report)).toBe(2);
		const stored = await built.database.query('select site_code, name from sites order by site_code', []);
		expect(stored).toEqual([
			{ site_code: 'SITE-C', name: 'Charlie' },
			{ site_code: 'SITE-D', name: 'Delta' }
		]);
	});
});
