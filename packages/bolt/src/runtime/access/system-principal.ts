import { createHmac } from 'node:crypto';
import { Config, Context, Effect, Option, Redacted } from 'effect';
import { EffectId, FacilityCall, InvocationId } from '@norbital-ai/bolt-protocol';
import type { ConfigResponse, FacilityBindings } from '@norbital-ai/bolt-protocol';
import type { PolicyDeclaration } from '../../authoring/workspace-schema.js';

/**
 * The host's own authority inside a tenant, and why it is a policy rather than a bypass.
 *
 * Provisioning happens before anybody exists in the workspace. There is no founder to authorize the
 * migration that would create the table a founder's row lives in, so the authority to run it cannot
 * come from the workspace's own membership — it has to come from the host. What that authority is
 * allowed to be is the whole question, and this module answers it in one place.
 *
 * It is deliberately *not* the shape that was just deleted. The compiler used to append
 * `{ name: 'local-authoring', roles: [], apps: ['*'], actions: ['*'] }` to every workspace, and
 * `subjectHasPolicy` returns `true` for an empty role array — so that declaration granted every
 * action on every app to every authenticated subject. It was reachable by anybody who could sign in,
 * which is what made it a fail-open rather than a grant.
 *
 * The difference here is not the wording; it is which subjects can match. `colony system` names a
 * non-empty role, and that role can be held by exactly one subject: one this boundary mints, in
 * memory, for a single invocation, after verifying an HMAC the host computed with a secret that
 * exists only in the host's environment. It is never read off a row, never accepted from a payload,
 * and never carried by anything a person can sign in as — see `SYSTEM_PRINCIPAL_ROLE` below.
 *
 * And what it may do is enumerated. Two resources, one action, listed here rather than `['*']`:
 *
 * - `manage` on `schema`, which is `schema.migrate` — the DDL that brings a virgin database up to
 *   its release. (`schema.plan`, `.verify`, `.validate` and `.fingerprint` authorize on `read` and
 *   are deliberately *not* granted: provisioning never calls them, and they disclose the whole
 *   schema unfiltered.)
 * - `manage` on `identity`, which is `identity.admitFounder` — writing the first administrator's
 *   roles and approver teams against their address before they have ever signed in.
 *
 * That is the entire list, and it is the entire list because those are the only two commands
 * provisioning dispatches into a tenant. Seeding is not here and does not need to be: the seeder
 * writes rows over the host's own `pg` connection to a database it just created, and never crosses
 * this boundary. Reading tenant data is not here either — `actions: ['manage']` does not include
 * `read`, so `rowPredicate` falls through to `decide`, finds no matching allow, and answers `false`
 * for every collection. A system principal can migrate a workspace and admit its founder. It cannot
 * open a single record in it.
 */
export const COLONY_SYSTEM_POLICY: PolicyDeclaration = Object.freeze<PolicyDeclaration>({
	name: 'colony system',
	description:
		'The host, provisioning a workspace before anybody exists in it. Reachable only by a request the host signed with its gateway secret.',
	effect: 'allow',
	/**
	 * Selected by a flag on the subject, never by a string the subject carries.
	 *
	 * This used to be `roles: ['colony-system']`, matched against `bolt_auth_user.roles` — so the one
	 * thing that made it forgeable was a row spelling it, and the guard was a second string match
	 * that stripped the role from every projected subject. A trapdoor watched by a filter.
	 *
	 * `system: true` is matched against `subject.system`, and `SystemPrincipal.systemSubject` is the
	 * only constructor of a subject carrying it. It is minted after `verifySystemSignature` returns
	 * true and cannot be decoded from a payload, so there is no route from a row, a credential, a
	 * cookie or an authored policy to holding it. An author declaring `system: true` on their own
	 * policy grants the host more than it needs and nobody else anything.
	 */
	system: true,
	actions: ['manage'],
	capabilities: { apps: ['schema', 'identity'] }
});

/** The subject id a system invocation runs under, so a log line names the actor rather than a uuid. */
export const SYSTEM_PRINCIPAL_ID = 'colony-system';

/**
 * The configuration key the host's signing secret is read from — the same `COLONY_GATEWAY_SECRET`
 * the host already verifies `/api/operations` bodies against, not a second secret minted for this.
 *
 * Read through Effect's `ConfigProvider` rather than `process.env`, for the reason
 * `BOLT_SECRETS_KEY` is: the runtime describes what it needs and the host supplies it, so the same
 * bundle runs in-process inside Colony and standalone inside bolt-server without either reaching for
 * an environment it should not know about.
 *
 * A host that sets no secret can mint no system principal. That is the correct failure: the check
 * below returns `false` rather than treating an unconfigured host as a trusted one.
 */
export const GATEWAY_SECRET_VARIABLE = 'COLONY_GATEWAY_SECRET';

/** The two headers a host-signed invocation carries. Named for the host, as `x-colony-impersonated-team` already is. */
export const SYSTEM_SIGNATURE_HEADER = 'x-colony-system-signature';
export const SYSTEM_TIMESTAMP_HEADER = 'x-colony-system-timestamp';

/**
 * How long a signature is good for.
 *
 * This is the answer to "how long does the authority last": one invocation, inside a five minute
 * window. There is no credential to revoke because none is issued — the previous design minted a
 * session row in the tenant database and had to remember to delete it, and a row that outlives its
 * provisioning is a standing key. A signature that is merely *stale* is refused by arithmetic.
 *
 * Wide enough for clock skew between a host and a runtime that may not share a machine, narrow
 * enough that a captured header is worthless long before anybody could find it. The comparison is
 * two-sided so a timestamp from the future is refused too.
 */
export const SIGNATURE_LIFETIME_MILLIS = 300_000;

/**
 * The bytes the host signs, rendered identically on both sides.
 *
 * Exported from bolt and imported by the host rather than restated there: two implementations of
 * "what exactly gets signed" is how a signature check comes to pass on a payload nobody meant to
 * authorize. The host builds this, HMACs it, and sends the digest; this module builds it again from
 * what actually arrived and compares.
 *
 * All four fields are in it, and each closes something. The `timestamp` bounds replay. The `command`
 * binds the signature to *this* command, so a digest captured from a `schema.migrate` cannot be
 * replayed onto an `identity.admitFounder`. The `tenantId` binds it to one workspace, so a signature
 * for a demo tenant cannot migrate a customer's. The canonical rendering of `input` binds it to the
 * arguments, so a captured `admitFounder` signature cannot be replayed with a different address —
 * which is the same property `/api/operations` gets by signing its raw request body, and the reason
 * a bearer token would not do.
 */
export const systemSignaturePayload = (parameters: {
	readonly timestamp: number;
	readonly command: string;
	readonly tenantId: string;
	readonly input: unknown;
}): string =>
	[
		String(parameters.timestamp),
		parameters.command,
		parameters.tenantId,
		canonicalJson(parameters.input)
	].join('\n');

/**
 * A rendering of a JSON value that does not depend on key order.
 *
 * `JSON.stringify` preserves insertion order, and the input the host signs is a literal it wrote
 * while the input this module verifies may have been round-tripped through a JSON body by
 * bolt-server. Sorting the keys is what makes those two the same string. Anything that is not JSON
 * renders as `null`, which can only ever fail a comparison rather than pass one.
 */
export const canonicalJson = (value: unknown): string => {
	if (value === null || value === undefined) return 'null';
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
	if (typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
		return `{${entries.join(',')}}`;
	}
	if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
	if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
	return 'null';
};

/** The digest a host computes over `systemSignaturePayload`, and the one this module recomputes. */
export const systemSignature = (secret: string, payload: string): string =>
	createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

/** Reads one header case-insensitively out of the protocol's multi-value shape. */
const headerValue = (
	headers: Readonly<Record<string, ReadonlyArray<string>>>,
	name: string
): string | undefined => {
	for (const [key, values] of Object.entries(headers)) {
		if (key.toLocaleLowerCase() !== name) continue;
		const first = values[0];
		if (typeof first === 'string' && first.length > 0) return first;
	}
	return undefined;
};

/**
 * What the runtime needs from the host's own environment, by key.
 *
 * The runtime describes the key and the host supplies the value — or says it has none. This is the
 * same contract the `config` facility carries across an isolate boundary, with one extra shape here:
 * a bundle running in a plain process (bolt-server) has no facility and answers from `process.env`
 * directly. Both render a missing or unreadable value as `None`, so a caller that fails closed on
 * absence does not have to know which world it is in.
 *
 * Only the runtime consumes this service. It is provided inside the invocation layer, where authored
 * workspace code cannot reach it — unlike `process.env` in a plain process, which is why the sandbox
 * deliberately does not hand the context one.
 */
export type HostConfigShape = Readonly<{
	/** The value of one key, `None` when the host has no value for it. `string` is the reason. */
	readonly read: (key: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, string>;
}>;

export const HostConfig = Context.Service<HostConfigShape>('@bolt/HostConfig');

/**
 * The `HostConfig` implementation for a bundle running in a plain process.
 *
 * Reads through Effect's `ConfigProvider` rather than `process.env`, for the same reason
 * `BOLT_SECRETS_KEY` does: Bolt describes a workspace and a host runs it, so ambient environment
 * access is an architecture violation the dependency audit fails on. The provider is the default in
 * a plain process, so this is the same value by a route a host or a test can control — and an
 * unreadable source collapses to `None`, the same fail-closed absence a host answering "no"
 * produces.
 */
export const hostConfigFromProcessEnv = (): HostConfigShape => ({
	read: (key) =>
		Config.option(Config.redacted(key)).pipe(
			Effect.match({
				onFailure: (): Option.Option<Redacted.Redacted<string>> => Option.none(),
				onSuccess: (value) => value
			})
		)
});

/**
 * The `HostConfig` implementation for a bundle running behind an isolate boundary.
 *
 * One round trip to the host per key, and a host that answers nothing — or fails — is the same
 * absence as one that has no value. The value never enters the sandbox as a global; it is carried
 * only inside the runtime's own environment for the invocation that asked.
 */
export const hostConfigFromFacility = (
	bindings: NonNullable<FacilityBindings['config']>
): HostConfigShape => ({
	read: (key) =>
		Effect.tryPromise(() =>
			bindings.call(
				FacilityCall.make({
					invocationId: InvocationId.make(`config:${key}`),
					effectId: EffectId.make(`config:${key}`),
					deadlineEpochMs: Date.now() + 30_000,
					idempotencyKey: `config:${key}`
				}),
				{ key },
				new AbortController().signal
			)
		).pipe(
			Effect.mapError((cause) => `config facility failed: ${String(cause)}`),
			Effect.flatMap((result) => {
				if (result._tag !== 'Success') {
					return Effect.fail(`config facility refused ${key}: ${result.error.message}`);
				}
				const response = result.value as ConfigResponse;
				return Effect.succeed(
					response.value === undefined || response.value.length === 0
						? Option.none()
						: Option.some(Redacted.make(response.value))
				);
			})
		)
});

/**
 * Whether this invocation was signed by the host that owns this bolt.
 *
 * Fail-closed at every step, and every step is a refusal rather than a downgrade: no header, no
 * secret configured, a malformed or stale timestamp, or a digest that does not match all answer
 * `false`, and the caller then goes on to demand an ordinary credential. Nothing here can *widen*
 * what an unsigned request may do.
 *
 * The digest is computed with WebCrypto (`crypto.subtle`) rather than `node:crypto`. The runtime
 * ships inside the same bundle a browser executes, where `node:buffer` and `node:crypto` are
 * externalized stubs that throw on access — and the sandbox context hands the runtime WebCrypto for
 * exactly this reason. The comparison is a constant-time string scan for the same reason the host's
 * own verifier uses `timingSafeEqual`: a byte-dependent shortcut leaks the expected digest one
 * measurement at a time, which is precisely what an HMAC exists to prevent.
 */
export const verifySystemSignature = Effect.fn('Bolt.verifySystemSignature')(
	function* (parameters: {
		readonly headers: Readonly<Record<string, ReadonlyArray<string>>>;
		readonly command: string;
		readonly tenantId: string;
		readonly input: unknown;
		readonly now: number;
	}) {
		const provided = headerValue(parameters.headers, SYSTEM_SIGNATURE_HEADER);
		const stamped = headerValue(parameters.headers, SYSTEM_TIMESTAMP_HEADER);
		if (provided === undefined || stamped === undefined) return false;
		const timestamp = Number(stamped);
		if (!Number.isSafeInteger(timestamp)) return false;
		if (Math.abs(parameters.now - timestamp) > SIGNATURE_LIFETIME_MILLIS) return false;
		// A configuration *source* failure collapses to "no secret", which is the fail-closed direction:
		// not being able to tell whether a secret exists means there is nothing to verify against, and an
		// unverified request is an unsigned one.
		//
		// The secret is read through the invocation's `HostConfig` — the value the host supplied for this
		// invocation, which is the only way a sandboxed runtime with no `process` can hold one. A bundle
		// running in a plain process gets the process-env implementation; a caller that provided neither
		// falls back to the ambient environment for the same reason.
		const hostConfig = Option.getOrElse(yield* Effect.serviceOption(HostConfig), () =>
			hostConfigFromProcessEnv()
		);
		const secret = yield* hostConfig
			.read(GATEWAY_SECRET_VARIABLE)
			.pipe(Effect.catch(() => Effect.succeed(Option.none<Redacted.Redacted<string>>())));
		if (Option.isNone(secret)) return false;
		const expected = yield* Effect.promise(() =>
			hmacHex(
				Redacted.value(secret.value),
				systemSignaturePayload({
					timestamp,
					command: parameters.command,
					tenantId: parameters.tenantId,
					input: parameters.input
				})
			)
		);
		const actual = provided.replace(/^sha256=/, '');
		return constantTimeEqual(expected, actual);
	}
);

/**
 * An HMAC-SHA256 digest as lowercase hex, through WebCrypto.
 *
 * The host computes the same digest with `node:crypto`; WebCrypto is the API both sides of this
 * boundary can actually reach — the runtime's bundle cannot touch `node:crypto`, and the sandbox
 * context deliberately hands it WebCrypto rather than Node's modules.
 */
const hmacHex = async (secret: string, payload: string): Promise<string> => {
	const material = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const digest = await crypto.subtle.sign('HMAC', material, new TextEncoder().encode(payload));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * Whether two equal-length strings are equal, without a byte-dependent early exit.
 *
 * The scan always walks the whole digest. Different lengths are refused up front — a length leak is
 * unobservable here because the digest length is a public property of SHA-256, and both sides of
 * this check already know it.
 */
const constantTimeEqual = (expected: string, actual: string): boolean => {
	if (expected.length !== actual.length) return false;
	let difference = 0;
	for (let index = 0; index < expected.length; index += 1) {
		difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
	}
	return difference === 0;
};

/** The shape `Identity.Subject` decodes to, restated structurally so this module imports no identity. */
export type SystemSubject = Readonly<{
	readonly userId: string;
	readonly tenantId: string;
	/** What selects `COLONY_SYSTEM_POLICY`, and the only key that does. */
	readonly system: true;
	readonly teamPath: ReadonlyArray<string>;
	readonly policies: ReadonlyArray<string>;
}>;

/**
 * The subject a verified signature runs as.
 *
 * Not an administrator. `admin` is deliberately absent, so `isAdministrator` is false and every
 * short-circuit it guards — `decide`, `rowPredicate`, `visibleApps`, `mayImpersonate` — stays shut.
 * The host's authority is the two grants `COLONY_SYSTEM_POLICY` enumerates and nothing else, which
 * is what makes "what can this credential do" a question with a written answer.
 *
 * It belongs to no team, so it holds no authored policy and is eligible to decide no approval.
 */
export const systemSubject = (tenantId: string): SystemSubject =>
	Object.freeze({
		userId: SYSTEM_PRINCIPAL_ID,
		tenantId,
		system: true,
		// No team, because a system principal approves nothing: `approvals.decide` matches a step's
		// approvers against the subject's own team, and inventing a membership would hand the host an
		// approval eligibility no workspace granted it.
		teamPath: [],
		// And no directly-named policies either. The host's authority is `COLONY_SYSTEM_POLICY`, which
		// is selected by the `system` flag above and by nothing a name can reach — so this array being
		// empty is what says the two routes to authority are genuinely separate.
		policies: []
	});

export * as SystemPrincipal from './system-principal.js';
