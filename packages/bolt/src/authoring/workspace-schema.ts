import type { FacilityName } from '@norbital-ai/bolt-protocol';
import { Schema, type Effect } from 'effect';
import type { AutomationDeclaration } from './automations-schema.js';
import type {
	BeforeApi,
	ChannelDefinition,
	PullCursorSpec,
	PullPagesSpec,
	PullRecordsSpec,
	PullRequestSpec,
	PullRetrySpec,
	SendRequestSpec,
	WebhookRequestSpec,
	WebhookSignatureSpec
} from './contracts-schema.js';
import type { ModelExclusion } from './models-schema.js';

/**
 * `uuid` is its own member rather than a flavour of `string`.
 *
 * Every record is keyed by `norbital_id uuid`, so a column that points at one has to be `uuid` too:
 * a foreign key planned as `text` cannot be compared with the key it references, and the relation
 * `EXISTS` join the where compiler emits — `"leave_requests"."employment_id" = "employments"."norbital_id"` —
 * fails outright with `operator does not exist: text = uuid`. The migration generator reads the
 * authored Drizzle builder and has always rendered `uuid`; only the schema plan flattened it, so a
 * Bolt-provisioned database and a lineage-provisioned one disagreed on every foreign key.
 */
export type ScalarType = 'string' | 'uuid' | 'number' | 'boolean' | 'datetime' | 'json';
export interface FieldDefinition<TType extends ScalarType = ScalarType> {
	readonly type: TType;
	readonly required: boolean;
	readonly indexed: boolean;
	/** Whether that index is a unique one. Only meaningful alongside `indexed`. */
	readonly unique?: boolean;
	/** Inline SQL for a `generatedAlwaysAs` column; the database computes it and nothing writes it. */
	readonly generated?: string;
	/**
	 * The PostgreSQL type the authored column builder declares, when the description was recovered
	 * from one.
	 *
	 * `type` above answers what a value *is* to queries, masking and the client catalog, where
	 * `integer`, `numeric` and `double precision` are all usefully one kind. DDL is the other
	 * question, and collapsing them there is not a simplification but a data loss: the schema plan
	 * rendered every `number` as `double precision`, so `component_entries.amount` — payroll money —
	 * was created as binary floating point, while the migration lineage created the same column
	 * `numeric` from the same builder. Whichever ran first won, and on a database provisioned from
	 * nothing that is always the plan.
	 *
	 * Carried alongside `type` rather than by widening `ScalarType`, because the two questions have
	 * different answers and one value cannot hold both. Absent for a hand-written `field.*`
	 * definition, which never had a builder to read, so the plan keeps its scalar mapping for those.
	 */
	readonly sqlType?: string;
	/**
	 * The column's DEFAULT, already rendered as the SQL literal the DDL carries.
	 *
	 * Same question as `sqlType` and the same answer for the same reason. `.default('MANUAL')` is
	 * part of the column's shape, and the schema plan had nowhere to put it: it created
	 * `roster_entries.origin` as `text not null` with no default while the migration lineage created
	 * the identical column `text DEFAULT 'MANUAL' NOT NULL`. The plan wins on a database provisioned
	 * from nothing, so every insert that relied on the default — all 2756 seeded roster rows, which
	 * correctly omit the column — was refused.
	 *
	 * Rendered SQL rather than the authored value, because a value cannot be written into DDL without
	 * being rendered, and the two places that would render it are exactly the two that disagreed
	 * about `numeric` and `uuid`. `describeModelColumns` renders it once, through Drizzle's own
	 * parameter mapping and the dialect's own literal escaping, so the plan and the lineage read one
	 * answer. Absent for a hand-written `field.*` definition, which has no builder to read.
	 */
	readonly sqlDefault?: string;
	/** Declared `enums()` members, used by the client catalog and column rendering. */
	readonly values?: ReadonlyArray<string>;
	/** The `custom('<name>')` type this column was declared as, when it was declared as one. */
	readonly customType?: string;
	/**
	 * Explicit search opt-in, authored as `text({ search: true })`.
	 *
	 * Search is opt-in because it decides what a free-text query may reach: a column nobody declared
	 * searchable is never matched, however text-like it is.
	 */
	readonly search?: boolean;
	/**
	 * The upload types authored as `file({ mimeTypes })`.
	 *
	 * The column holds a file id, so nothing about the file is knowable here at write time — this
	 * only exists to reach the surface that offers the upload, which is why it travels on the field
	 * description and is projected by `workspace.manifest` rather than checked anywhere.
	 */
	readonly mimeTypes?: ReadonlyArray<string>;
}
/** Owns make field behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
const makeField = <TType extends ScalarType>(type: TType) =>
	(
		options: {
			readonly required?: boolean;
			readonly indexed?: boolean;
			/**
			 * Makes the column's index unique — one row per value.
			 *
			 * Needed wherever an upsert conflicts on the column rather than on the key: `on conflict`
			 * requires a unique index to conflict against, and without one the statement does not
			 * degrade, it fails. `bolt_auth_user.email` is the case that forced this — the write that
			 * admits a workspace's first administrator is an upsert on the address, made before that
			 * person exists.
			 */
			readonly unique?: boolean;
			/**
			 * The column's DEFAULT, as the SQL literal the DDL carries — see `sqlDefault` above.
			 *
			 * A builder-authored model gets this from the builder. A runtime-owned collection is these
			 * `field.*` calls and had no way to say it, so `required: true` rendered `not null` with no
			 * default and every insert that correctly omits the column was refused. That is the same
			 * failure `roster_entries.origin` had, one layer up.
			 */
			readonly sqlDefault?: string;
		} = {}
	): FieldDefinition<TType> => {
		const required = options.required ?? false;
		const indexed = options.indexed ?? false;
		if (typeof required !== 'boolean') {
			throw new TypeError(`Field ${type} required flag must be boolean.`);
		}
		if (typeof indexed !== 'boolean') {
			throw new TypeError(`Field ${type} indexed flag must be boolean.`);
		}
		const unique = options.unique ?? false;
		if (typeof unique !== 'boolean') {
			throw new TypeError(`Field ${type} unique flag must be boolean.`);
		}
		if (unique && !indexed) {
			throw new TypeError(`Field ${type} cannot be unique without being indexed.`);
		}
		return Object.freeze({
			type,
			required,
			indexed,
			...(unique ? { unique } : {}),
			...(options.sqlDefault === undefined ? {} : { sqlDefault: options.sqlDefault })
		});
	};
/**
 * `uuid` is here because a column that references another collection has to be one.
 *
 * Every collection is keyed by `norbital_id uuid`, so a foreign key into one is `uuid` too — and a
 * `text` column planned in its place is the `operator does not exist: text = uuid` the where compiler
 * hits when it renders the join it planned. Authored models get this type from their builder; a
 * runtime-owned collection is `field.*` calls and had no way to say it.
 */
export const field = { string: makeField('string'), number: makeField('number'), boolean: makeField('boolean'), datetime: makeField('datetime'), json: makeField('json'), uuid: makeField('uuid') };
export interface CollectionDefinition<Fields extends Readonly<Record<string, FieldDefinition>>> {
	readonly name: string;
	readonly fields: Fields;
	readonly history: boolean;
	readonly approvalLock?: boolean;
	/**
	 * What the collection is, and the icon a host surface lists it under.
	 *
	 * Both are `defineModel` metadata, declared by 60 and 56 template models between them and read by
	 * nothing: they had no key on this interface to land in, so `renderArtifact` had nowhere to lift
	 * them to and `workspace.manifest` had nothing to project.
	 */
	readonly description?: string;
	readonly icon?: string;
	/** Declared hook points, as `operation.phase` — what the Studio counts per collection. */
	readonly hooks?: ReadonlyArray<string>;
	/**
	 * The `defineModel` metadata's EXCLUDE constraints, carried through because the schema plan is the
	 * only thing that can render them: Drizzle has no entity for an exclusion, so unlike an index they
	 * cannot travel as part of the compiled table.
	 */
	readonly exclusions?: ReadonlyArray<ModelExclusion>;
	/** Workspace-relative path of the authored model, so a host surface can link to its source. */
	readonly sourcePath?: string;
}

/** Names one side of an authored relationship foreign key. */
export interface RelationEndpoint {
	readonly collection: string;
	readonly column: string;
}

/** One `r.one` / `r.many` edge emitted from `+relationship.ts` into the workspace artifact. */
export interface RelationDefinition {
	readonly name: string;
	readonly source: string;
	readonly target: string;
	readonly cardinality: 'one' | 'many';
	readonly from?: RelationEndpoint;
	readonly to?: RelationEndpoint;
	/**
	 * Whether the parent owns this row outright, so deleting it deletes this one.
	 *
	 * Declared by wrapping the relation in `cascade(...)`. That wrapper existed and did nothing: the
	 * relation parser tolerated the call and stripped it, nothing carried a flag, and every foreign
	 * key in every workspace was emitted `NO ACTION`. So a payroll run could not be deleted once it
	 * had written a payslip — which is the documented way to release the settlement locks it holds
	 * over attendance — and a declaration that reads as meaningful meant nothing at all.
	 */
	readonly cascade?: boolean;
}
/** Owns collection behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const collection = <const Fields extends Readonly<Record<string, FieldDefinition>>>(options: {
	readonly name: string;
	readonly fields: Fields;
	readonly history?: boolean;
	readonly approvalLock?: boolean;
	readonly description?: string;
	readonly icon?: string;
	readonly exclusions?: ReadonlyArray<ModelExclusion>;
}): CollectionDefinition<Fields> => {
	const name = options.name.trim();
	if (name === '') {
		throw new TypeError('Collection name cannot be empty.');
	}
	for (const fieldName of Object.keys(options.fields)) {
		if (fieldName.trim() === '') {
			throw new TypeError(`Collection ${name} contains an empty field name.`);
		}
	}
	return Object.freeze({ ...options, name, history: options.history ?? true });
};

/**
 * A channel in the workspace definition: exactly what the author wrote in `+<name>.channel.ts`,
 * plus the two facts the module cannot state about itself — the file's name and the agent bound to
 * answer on it.
 *
 * It extends the authored definition rather than restating a field list, because restating one is
 * how the two drifted apart. This declaration used to ask `audience: 'direct' | 'group' | 'both'`
 * while the authored definition asked `audience: 'public' | 'authenticated'`, and those are not the
 * same question: the first is what shape of conversation a channel carries, the second is who may
 * reach it. Reach is the one that survives, on two grounds. It is the axis the only consumer tests
 * — `conversation-selector.ts` routes a public channel's threads to the admin inbox and keeps them
 * off every member's — and the shape question is already asked, more precisely, by `groupMessages`,
 * which also says how a group message triggers the agent. `both` could not express that.
 */
export interface ChannelDeclaration extends ChannelDefinition {
	readonly name: string;
	readonly agent: string;
}
/** Owns channel behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const channel = (declaration: ChannelDeclaration): ChannelDeclaration => {
	if (declaration.name.trim() === '') throw new TypeError('Channel name cannot be empty.');
	if (declaration.transport.trim() === '') throw new TypeError(`Channel ${declaration.name} requires a transport.`);
	if (declaration.agent.trim() === '') throw new TypeError(`Channel ${declaration.name} requires an agent.`);
	if (!['public', 'authenticated'].includes(declaration.audience)) {
		throw new TypeError(`Channel ${declaration.name} has an unsupported audience.`);
	}
	return Object.freeze({
		...declaration,
		name: declaration.name.trim()
	});
};
/**
 * One inbound binding as the *declaration* — everything about a pull that survives `JSON.stringify`.
 *
 * The half that cannot: the record schema, the identity reader, and the optional mapper are live
 * objects and functions, so they ride beside the declaration in the artifact's authored runtime
 * (`AuthoredRuntime.integrations`) exactly as models, hooks and pipelines already do. This half is
 * what a host can read out of a manifest — most importantly `schedule`, which is the only thing a
 * host scheduler needs to know to run the job.
 */
export interface IntegrationPullDeclaration {
	readonly name: string;
	readonly schedule: string;
	readonly method: 'GET' | 'POST';
	readonly path: string;
	readonly query?: Readonly<Record<string, string>>;
	readonly headers?: Readonly<Record<string, string>>;
	readonly cursor?: PullCursorSpec;
	readonly pages?: PullPagesSpec;
	readonly retry?: PullRetrySpec;
	readonly records?: PullRecordsSpec;
	/** The collection column the external key lands in — the column the idempotent upsert matches on. */
	readonly identityColumn: string;
}

/**
 * One authored integration, scoped to the collection whose directory declared it.
 *
 * `name` is `<collection>.<integration>` because that is what the file system said: two collections
 * may both mirror "erp", and they are two integrations with two cursors, not one.
 *
 * The `connector`/`conflict` pair this interface used to carry is gone. `connector` named a
 * host-side connector registry that no host ever had an entry in, and `conflict` named a
 * three-valued merge policy no line of code has ever read — the source of record is the source of
 * record, and the upsert is keyed by the external identity.
 */
/**
 * One *pushed* inbound binding as the declaration — the half of a webhook that survives
 * `JSON.stringify`.
 *
 * It carries the whole signature specification, secret name included. That is deliberate and it is
 * safe: `{ env: 'NAME' }` is a *name*, and the vault it names is the host's. The artifact says which
 * secret verifies this route, exactly as it already says which secret authenticates a pull's bearer
 * token; nothing about the value travels. An artifact that omitted the specification would leave the
 * host to guess a scheme, and a guessed verification scheme is an unverified route.
 */
export interface IntegrationWebhookDeclaration {
	readonly name: string;
	/** The route the host mounts for this binding. */
	readonly path: string;
	readonly signature: WebhookSignatureSpec;
	readonly eventIdHeader?: string;
	readonly records?: PullRecordsSpec;
	/** The collection column the external key lands in — the column the idempotent upsert matches on. */
	readonly identityColumn: string;
}

/** Which collection writes an outbound binding subscribes to. */
export type IntegrationSendEvent = 'create' | 'update' | 'delete';

/**
 * One *outbound* binding as the declaration — the half of a send that survives `JSON.stringify`.
 *
 * `events` is the list the trigger normalised to, and it is here rather than only in the live half
 * because the write path has to decide whether a row change concerns this binding *before* it is
 * willing to call anything: an integration with no `update` binding must cost an update nothing. The
 * predicates themselves are closures and travel in the authored half beside `map` and `identity`.
 */
export interface IntegrationSendDeclaration {
	readonly name: string;
	readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	/** May carry `{column}` tokens, filled from the stored record at delivery time. */
	readonly path: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly retry?: PullRetrySpec;
	/** The header the platform's derived delivery key rides in. Defaults to `idempotency-key`. */
	readonly idempotencyHeader?: string;
	readonly events: ReadonlyArray<IntegrationSendEvent>;
}

/**
 * One authored integration, scoped to the collection whose directory declared it.
 *
 * `name` is `<collection>.<integration>` because that is what the file system said: two collections
 * may both mirror "erp", and they are two integrations with two cursors, not one.
 *
 * The `connector`/`conflict` pair this interface used to carry is gone. `connector` named a
 * host-side connector registry that no host ever had an entry in, and `conflict` named a
 * three-valued merge policy no line of code has ever read — the source of record is the source of
 * record, and the upsert is keyed by the external identity.
 *
 * `receive` and `webhooks` are two arrays rather than one union-typed array because a host does two
 * different things with them — register a cron job, or mount a route — and the declarations have
 * almost nothing in common to read: a pull has a schedule, a cursor and paging, and a webhook has a
 * path and a signature. Collapsing them would make every consumer narrow before it could do either.
 * The authoring surface *is* unified, where the author sees it: both are declared in the single
 * `receive` map of `+integrations.ts`, so a binding name is unique across both by construction.
 */
export interface IntegrationDeclaration {
	readonly name: string;
	readonly collection: string;
	/**
	 * Where this integration's requests go — absent for an integration that only receives pushes.
	 *
	 * A webhook has nothing to request: it is delivered to, so there is no base URL and no outbound
	 * credential. `describeIntegrations` still requires one the moment a pull is declared, so a pull
	 * can never reach the runtime without somewhere to go.
	 */
	readonly connection?: HttpConnection;
	readonly receive: ReadonlyArray<IntegrationPullDeclaration>;
	readonly webhooks: ReadonlyArray<IntegrationWebhookDeclaration>;
	/**
	 * The outbound bindings, in their own array for the reason the other two are in theirs: a host
	 * and the runtime do a different thing with each. A pull is a cron, a webhook is a route, and a
	 * send is a queue drained on a schedule — they share a connection and nothing else.
	 */
	readonly send: ReadonlyArray<IntegrationSendDeclaration>;
}
/** Owns integration behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const integration = (declaration: IntegrationDeclaration): IntegrationDeclaration => {
	if (declaration.name.trim() === '') throw new TypeError('Integration name cannot be empty.');
	if (declaration.collection.trim() === '') throw new TypeError(`Integration ${declaration.name} requires a collection.`);
	for (const binding of declaration.receive) {
		if (binding.name.trim() === '') throw new TypeError(`Integration ${declaration.name} has an unnamed receive binding.`);
		if (binding.path.trim() === '') throw new TypeError(`Integration ${declaration.name}.${binding.name} requires a path.`);
		if (binding.identityColumn.trim() === '') {
			throw new TypeError(`Integration ${declaration.name}.${binding.name} requires an identity column: without one a second run cannot recognise the rows the first run wrote.`);
		}
	}
	for (const binding of declaration.webhooks) {
		if (binding.name.trim() === '') throw new TypeError(`Integration ${declaration.name} has an unnamed webhook binding.`);
		if (binding.path.trim() === '') throw new TypeError(`Integration ${declaration.name}.${binding.name} requires a path.`);
		if (binding.identityColumn.trim() === '') {
			throw new TypeError(`Integration ${declaration.name}.${binding.name} requires an identity column: webhook delivery is at-least-once, so without one a redelivery becomes a second row.`);
		}
		assertVerifiableSignature(`${declaration.name}.${binding.name}`, binding.signature);
	}
	for (const binding of declaration.send) {
		if (binding.name.trim() === '') throw new TypeError(`Integration ${declaration.name} has an unnamed send binding.`);
		if (binding.path.trim() === '') throw new TypeError(`Integration ${declaration.name}.${binding.name} requires a path.`);
		if (binding.events.length === 0) {
			throw new TypeError(`Integration ${declaration.name}.${binding.name} subscribes to no collection event, so nothing could ever queue a delivery for it.`);
		}
	}
	return Object.freeze({
		...declaration,
		name: declaration.name.trim(),
		receive: Object.freeze([...declaration.receive]),
		webhooks: Object.freeze([...declaration.webhooks]),
		send: Object.freeze([...declaration.send])
	});
};

/** The replay window a binding gets when it does not name one: five minutes, in seconds. */
export const WEBHOOK_DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Refuses a signature specification that cannot actually verify anything.
 *
 * Both refusals are here rather than left to the runtime because both produce a route that *looks*
 * verified. A binding that names no secret would verify against an empty key, and a binding whose
 * freshness check reads a timestamp the signature does not cover would reject nothing at all: an
 * attacker replaying a captured body edits the unsigned timestamp header and the window slides with
 * them. That second one is the trap worth failing the build over — it is invisible in review, and
 * every test of it passes.
 */
const assertVerifiableSignature = (binding: string, signature: WebhookSignatureSpec): void => {
	if (signature.header.trim() === '') {
		throw new TypeError(`Integration ${binding} declares no signature header; there is nowhere to read the proof from.`);
	}
	if (signature.secret.env.trim() === '') {
		throw new TypeError(`Integration ${binding} declares no signature secret; verification against an empty key accepts a digest anybody can compute.`);
	}
	const template = signature.signedPayload ?? '{body}';
	if (!template.includes('{body}')) {
		throw new TypeError(`Integration ${binding} signs a payload template that omits {body}, so the signature would not cover the delivery at all.`);
	}
	if (signature.timestamp !== undefined && !template.includes('{timestamp}')) {
		throw new TypeError(`Integration ${binding} reads a timestamp for replay defence but signs a payload that omits {timestamp}. An unsigned timestamp is attacker-controlled, so the freshness window would refuse nothing.`);
	}
	if (signature.toleranceSeconds !== undefined && !(signature.toleranceSeconds > 0)) {
		throw new TypeError(`Integration ${binding} declares a replay window of ${signature.toleranceSeconds}s; a window that is not positive refuses every delivery including the live one.`);
	}
	if ('parameter' in (signature.timestamp ?? {}) && signature.parameter === undefined && signature.prefix === undefined) {
		// Stripe's shape: both values live in one `k=v,k=v` header, so the signature has to be named too.
		throw new TypeError(`Integration ${binding} reads its timestamp from a parameter of ${signature.header} but does not say which parameter carries the signature.`);
	}
};
export interface PrivateEnvReference { readonly env: string; }
export interface HttpConnection { readonly baseUrl: string; readonly authentication?: { readonly type: 'bearer'; readonly token: PrivateEnvReference } | { readonly type: 'header'; readonly header: string; readonly value: PrivateEnvReference }; }
/** Owns define connection behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const defineConnection = <const Connection extends HttpConnection>(connection: Connection): Connection => {
	const url = new URL(connection.baseUrl);
	if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
		throw new TypeError('Connection URLs must use HTTPS outside localhost development.');
	}
	if (connection.authentication?.type === 'header' && connection.authentication.header.trim() === '') {
		throw new TypeError('Header authentication requires a non-empty header name.');
	}
	return Object.freeze({
		...connection,
		baseUrl: url.toString().replace(/\/$/, '')
	});
};

/**
 * Declares one inbound binding, with the record type flowing from `input` into everything that
 * reads a record.
 *
 * The builder exists for inference and nothing else. `receive` is a `Record<string, …>` in the
 * collection's `Integrations` type, and a record's value type cannot vary per key — so an inline
 * object literal gets `never` for its record parameter and `(vendor) => vendor.external_code` fails
 * to compile on a perfectly correct declaration. Wrapping the binding in a generic function is how
 * `defineAgentTool` and `defineCustomType` already solve the same problem.
 *
 * What is checked, and where: `input` fixes the record type; `identity.value`, `resolve` and `map`
 * are then checked against it here, and `map`'s *return* is checked against the collection's insert
 * type by the `satisfies Integrations` on the module's default export. `Resolved` is inferred from
 * `resolve` alone — `map`'s second parameter is a `NoInfer` position — so a `map` that reads the
 * resolution wrongly is an error at `map` rather than a silently widened `resolve`.
 */
export const definePull = <Record_, Encoded, Row, Resolved = undefined>(binding: {
	readonly pull: PullRequestSpec;
	readonly input: Schema.Codec<Record_, Encoded>;
	readonly records?: PullRecordsSpec;
	readonly identity: { readonly column: string; readonly value: (record: Record_) => string };
	readonly resolve?: (context: { readonly records: ReadonlyArray<Record_>; readonly api: BeforeApi }) =>
		| Effect.Effect<Resolved, unknown, never>
		| Promise<Resolved>
		| Resolved;
	readonly map?: (record: Record_, resolved: NoInfer<Resolved>) => Row;
}): typeof binding => binding;

/**
 * Declares one *pushed* inbound binding — a route the source delivers to, verified before it counts.
 *
 * The same builder-for-inference reason as `definePull`, and the same three record-typed members:
 * `input` fixes the record type, `identity.value` and `map` are checked against it here, and `map`'s
 * return is checked against the collection's insert type by the `satisfies Integrations` on the
 * module's default export.
 *
 * What is different is that the specification is checked *now*, at authoring time, rather than
 * carried and hoped for. A pull that is misdeclared fails visibly on its next run: it fetches
 * nothing, or it fetches and rejects every record, and the report says so. A webhook that is
 * misdeclared fails invisibly in the only direction that matters — it accepts. So the two
 * declarations that would produce a route that looks verified and is not (no secret, or a freshness
 * check over an unsigned timestamp) throw here, where the workspace is compiled, rather than
 * degrading quietly at delivery time.
 *
 * `map` is still pure and synchronous, and `resolve` is what lets a binding fill a required `uuid`
 * foreign key anyway — the limit that once killed the field-operations `jobs` webhook. It runs once
 * per delivery with an `api`, and its result is `map`'s second argument, so a body carrying a site
 * *code* becomes a row carrying a `site_id`. One lookup per delivery, not one per event in it.
 */
export const defineWebhook = <Record_, Encoded, Row, Resolved = undefined>(binding: {
	readonly webhook: WebhookRequestSpec;
	readonly input: Schema.Codec<Record_, Encoded>;
	readonly records?: PullRecordsSpec;
	readonly identity: { readonly column: string; readonly value: (record: Record_) => string };
	readonly resolve?: (context: { readonly records: ReadonlyArray<Record_>; readonly api: BeforeApi }) =>
		| Effect.Effect<Resolved, unknown, never>
		| Promise<Resolved>
		| Resolved;
	readonly map?: (record: Record_, resolved: NoInfer<Resolved>) => Row;
}): typeof binding => {
	if (binding.webhook.path.trim() === '') {
		throw new TypeError('A webhook binding requires a path: a route with no path is a route nothing can deliver to.');
	}
	if (binding.identity.column.trim() === '') {
		throw new TypeError('A webhook binding requires an identity column: webhook delivery is at-least-once, so without one a redelivery becomes a second row.');
	}
	assertVerifiableSignature(binding.webhook.path, binding.webhook.signature);
	return binding;
};

/**
 * Declares one *outbound* binding — a row changed here, so a request goes out about it.
 *
 * The builder exists for the same inference reason `definePull` does, and for one more: `on` is
 * where the row type has to land. `Row` flows into the trigger predicates and into `body`, so an
 * author writes `(context) => context.record.status === 'shipped'` and gets a checked field access
 * rather than `never`.
 *
 * What this deliberately does **not** offer is a hook that fires the request. `on` is a predicate
 * evaluated on the write path, and `body` is a pure function of the event; both are synchronous and
 * neither may reach the network, because the alternative is every tenant write waiting on somebody
 * else's availability. The request is queued in the same transaction as the row and drained
 * afterwards, which is why the delivery contract is at-least-once rather than exactly-once: an HTTP
 * boundary cannot be crossed exactly once, and a platform that claimed it would be lying about the
 * one case it exists to handle.
 */
export const defineSend = <Row>(binding: {
	readonly send: SendRequestSpec;
	readonly on:
		| 'create'
		| 'update'
		| 'delete'
		| {
			readonly create?: (context: { readonly record: Row }) => boolean;
			readonly update?: (context: { readonly previous: Row; readonly record: Row }) => boolean;
			readonly delete?: (context: { readonly record: Row }) => boolean;
		};
	readonly body?: (event: {
		readonly operation: 'create' | 'update' | 'delete';
		readonly record: Row;
		readonly previous?: Row;
	}) => unknown;
}): typeof binding => {
	if (binding.send.path.trim() === '') {
		throw new TypeError('A send binding requires a path: there is nowhere to deliver to without one.');
	}
	if (typeof binding.on === 'object' && binding.on.create === undefined && binding.on.update === undefined && binding.on.delete === undefined) {
		throw new TypeError('A send binding subscribes to no collection event, so nothing could ever queue a delivery for it.');
	}
	return binding;
};

export interface ToolDeclaration { readonly name: string; readonly description: string; readonly command: string; }
export interface AgentDeclaration { readonly name: string; readonly prompt: string; readonly tools: ReadonlyArray<ToolDeclaration>; readonly skills: ReadonlyArray<string>; }
/** Owns tool behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const tool = (declaration: ToolDeclaration): ToolDeclaration => {
	if (!/^[a-z][a-z0-9_.-]*$/.test(declaration.name)) {
		throw new TypeError(`Tool name "${declaration.name}" is invalid.`);
	}
	if (declaration.description.trim() === '') throw new TypeError(`Tool ${declaration.name} requires a description.`);
	if (declaration.command.trim() === '') throw new TypeError(`Tool ${declaration.name} requires a command.`);
	return Object.freeze({
		...declaration,
		description: declaration.description.trim(),
		command: declaration.command.trim()
	});
};
/** Owns agent behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const agent = (declaration: AgentDeclaration): AgentDeclaration => {
	if (!/^[a-z][a-z0-9_.-]*$/.test(declaration.name)) throw new TypeError(`Agent name "${declaration.name}" is invalid.`);
	if (declaration.prompt.trim() === '') throw new TypeError(`Agent ${declaration.name} requires a prompt.`);
	const toolNames = declaration.tools.map(({ name }) => name);
	if (new Set(toolNames).size !== toolNames.length) throw new TypeError(`Agent ${declaration.name} contains duplicate tools.`);
	if (new Set(declaration.skills).size !== declaration.skills.length) throw new TypeError(`Agent ${declaration.name} contains duplicate skills.`);
	return Object.freeze({
		...declaration,
		prompt: declaration.prompt.trim(),
		tools: Object.freeze([...declaration.tools]),
		skills: Object.freeze([...declaration.skills])
	});
};
export interface RuntimePolicyGrant {
	readonly collection: string;
	readonly action: 'read' | 'create' | 'update' | 'delete' | 'history';
	readonly where?: Readonly<Record<string, unknown>>;
	readonly fields?: ReadonlyArray<string>;
	readonly approval?: unknown;
}
export interface PolicyDeclaration {
	readonly name: string;
	readonly description?: string;
	readonly effect?: 'allow' | 'deny';
	readonly actions?: ReadonlyArray<string>;
	readonly roles?: ReadonlyArray<string>;
	readonly apps?: ReadonlyArray<string>;
	readonly grants?: ReadonlyArray<RuntimePolicyGrant>;
}
/** Owns policy behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const policy = (declaration: PolicyDeclaration): PolicyDeclaration => {
	if (declaration.name.trim() === '') throw new TypeError('Policy name cannot be empty.');
	if ((declaration.actions?.length ?? 0) === 0 && (declaration.grants?.length ?? 0) === 0) {
		throw new TypeError(`Policy ${declaration.name} must declare actions or collection grants.`);
	}
	for (const grant of declaration.grants ?? []) {
		if (grant.collection.trim() === '') throw new TypeError(`Policy ${declaration.name} contains an empty collection grant.`);
		if (grant.fields !== undefined && new Set(grant.fields).size !== grant.fields.length) {
			throw new TypeError(`Policy ${declaration.name} grant ${grant.collection} contains duplicate field masks.`);
		}
	}
	return Object.freeze({ ...declaration, name: declaration.name.trim() });
};

export interface EnvironmentDeclaration { readonly name: string; readonly production: boolean; }
/** Owns environment behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const environment = (name: string, options: { readonly production?: boolean } = {}): EnvironmentDeclaration => {
	const normalized = name.trim();
	if (!/^[a-z][a-z0-9-]*$/.test(normalized)) {
		throw new TypeError(`Environment name "${name}" must be lowercase kebab-case.`);
	}
	if (options.production !== undefined && typeof options.production !== 'boolean') {
		throw new TypeError(`Environment ${normalized} production flag must be boolean.`);
	}
	return Object.freeze({
		name: normalized,
		production: options.production ?? false
	});
};
export interface EnvVarConfig { readonly schema?: Schema.Codec<string | undefined, unknown>; readonly public?: boolean; readonly static?: boolean; readonly description?: string; }
/** Owns environment-variable authoring validation while retaining each literal declaration type. */
const EnvironmentVariables = {
	define: <const Variables extends Readonly<Record<string, EnvVarConfig>>>(variables: Variables): Variables => {
		for (const [name, config] of Object.entries(variables)) {
			if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
				throw new TypeError(`Environment variable "${name}" must be UPPER_SNAKE_CASE.`);
			}
			if (config.description !== undefined && config.description.trim() === '') {
				throw new TypeError(`Environment variable ${name} has an empty description.`);
			}
			if (config.public && !name.startsWith('PUBLIC_')) {
				throw new TypeError(`Public environment variable ${name} must use the PUBLIC_ prefix.`);
			}
		}
		return Object.freeze(variables);
	}
};

export const defineEnvVars = EnvironmentVariables.define;

export interface AppDeclaration {
	readonly name: string;
	readonly label: string;
}

/**
 * One entry of the migration lineage, as it travels inside the artifact.
 *
 * `tag` is the `<UTC timestamp>_<name>` directory name, which is both the identity the ledger
 * records and the sort key that fixes application order. `statements` is `migration.sql` already
 * split on `--> statement-breakpoint`, so the runtime never parses SQL: the compiler reads the file
 * once and the host applies what it is given, hand-authored statements included, in file order.
 *
 * The snapshot beside each `migration.sql` is deliberately absent. It is the *generator's* input —
 * the previous shape to diff against — and nothing applies it; carrying it would add megabytes to
 * every artifact for a value the host has no use for.
 */
export interface WorkspaceMigrationEntry {
	readonly tag: string;
	readonly statements: ReadonlyArray<string>;
}

export interface WorkspaceDefinition {
	readonly name: string;
	readonly version: string;
	readonly collections: ReadonlyArray<CollectionDefinition<Readonly<Record<string, FieldDefinition>>>>;
	readonly relations: ReadonlyArray<RelationDefinition>;
	/**
	 * Authored custom-type definitions, keyed by declared name.
	 *
	 * Held as `unknown` because a definition's `schema` is a Standard Schema from whichever library
	 * the author uses; the runtime reads it through `~standard` and never depends on the library.
	 */
	readonly customTypes?: Readonly<Record<string, unknown>>;
	/** The `+env.ts` declaration: which environment variables this workspace expects, never values. */
	readonly environment?: import('./environment-schema.js').EnvironmentSpec;
	readonly apps: ReadonlyArray<AppDeclaration>;
	readonly policies: ReadonlyArray<PolicyDeclaration>;
	readonly agents: ReadonlyArray<AgentDeclaration>;
	readonly automations: ReadonlyArray<AutomationDeclaration>;
	readonly channels: ReadonlyArray<ChannelDeclaration>;
	readonly integrations: ReadonlyArray<IntegrationDeclaration>;
	readonly requiredFacilities: ReadonlyArray<FacilityName>;
	/**
	 * The workspace's `.norbital/migrations` lineage, oldest first.
	 *
	 * It rides the definition rather than the bundle manifest because the manifest is a
	 * `bolt-protocol` schema the host decodes: adding a field there makes an artifact undecodable by
	 * every host older than the change, for data no host-side code reads. The lineage is only ever
	 * read by `WorkspaceSchema.migrate`, which already holds the definition.
	 */
	readonly migrations?: ReadonlyArray<WorkspaceMigrationEntry>;
}

/** Accepts an authored workspace before `relations` is normalized to an array. */
export type WorkspaceDraft = Omit<WorkspaceDefinition, 'relations'> & {
	readonly relations?: ReadonlyArray<RelationDefinition>;
};

/** Owns workspace behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const workspace = (definition: WorkspaceDraft): WorkspaceDefinition => {
	if (definition.name.trim() === '') throw new TypeError('Workspace name cannot be empty.');
	if (definition.version.trim() === '') throw new TypeError(`Workspace ${definition.name} requires a version.`);
	const registries = [definition.collections, definition.apps, definition.policies, definition.agents, definition.automations, definition.channels, definition.integrations];
	for (const registry of registries) {
		const names = registry.map(({ name }) => name);
		if (new Set(names).size !== names.length) throw new TypeError(`Workspace ${definition.name} contains duplicate declarations.`);
	}
	if (new Set(definition.requiredFacilities).size !== definition.requiredFacilities.length) {
		throw new TypeError(`Workspace ${definition.name} contains duplicate required facilities.`);
	}
	return Object.freeze({
		...definition,
		name: definition.name.trim(),
		version: definition.version.trim(),
		relations: Object.freeze([...(definition.relations ?? [])])
	});
};
/** Owns app behavior at the authoring boundary so validation and typed semantics stay consistent for every caller. */
export const app = (declaration: AppDeclaration): AppDeclaration => {
	const name = declaration.name.trim();
	const label = declaration.label.trim();
	if (!/^[a-z][a-z0-9_/-]*$/.test(name)) {
		throw new TypeError(`Application name "${declaration.name}" is invalid.`);
	}
	if (label === '') {
		throw new TypeError(`Application ${name} requires a visible label.`);
	}
	return Object.freeze({
		name,
		label
	});
};
