import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Config, Effect, Option, Redacted } from 'effect';
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
	// Never `[]`. An empty array is the `local-authoring` footgun exactly — `subjectHasPolicy`
	// returns `true` for it, which would make this policy match every authenticated subject in the
	// workspace instead of the one subject the signature check mints.
	roles: ['colony-system'],
	actions: ['manage'],
	apps: ['schema', 'identity']
});

/**
 * The role that selects the policy above, and the reason no ordinary subject can hold it.
 *
 * `subjectHasPolicy` matches a subject to a policy by role, and `Identity.authenticate` builds
 * `subject.roles` from the `roles` column of `bolt_auth_user`. So the one thing that would make this
 * forgeable is a row carrying it — a founder admitted with it, a seed fixture that spells it, a host
 * writing it into the provisioner's row. `Identity.subjectFromRow` therefore *strips* this role from
 * every subject it projects, whatever the column says. There is no route from a database row, a
 * credential, a cookie or a payload to a subject holding it; `dispatchInvocation` is the only
 * constructor, and it runs after `verifySystemSignature`.
 *
 * Authored workspace code cannot reach it either. A policy an author writes is data in the workspace
 * definition, and adding `roles: ['colony-system']` to one grants that policy to nobody, because
 * nothing mints a subject with the role. The only thing an author could do is declare a *second*
 * policy that this role also matches, which grants the host more than it needs and nothing to
 * anybody else.
 */
export const SYSTEM_PRINCIPAL_ROLE = 'colony-system';

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
 * Whether this invocation was signed by the host that owns this bolt.
 *
 * Fail-closed at every step, and every step is a refusal rather than a downgrade: no header, no
 * secret configured, a malformed or stale timestamp, or a digest that does not match all answer
 * `false`, and the caller then goes on to demand an ordinary credential. Nothing here can *widen*
 * what an unsigned request may do.
 *
 * The comparison is `timingSafeEqual` for the same reason the host's own verifier is: a
 * byte-dependent shortcut leaks the expected digest one measurement at a time, which is precisely
 * what an HMAC exists to prevent.
 */
export const verifySystemSignature = Effect.fn('Bolt.verifySystemSignature')(function* (parameters: {
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
	const configured = yield* Config.option(Config.redacted(GATEWAY_SECRET_VARIABLE)).pipe(
		Effect.match({
			onFailure: (): Option.Option<Redacted.Redacted<string>> => Option.none(),
			onSuccess: (value) => value
		})
	);
	if (Option.isNone(configured)) return false;
	const expected = Buffer.from(
		systemSignature(
			Redacted.value(configured.value),
			systemSignaturePayload({
				timestamp,
				command: parameters.command,
				tenantId: parameters.tenantId,
				input: parameters.input
			})
		),
		'utf8'
	);
	const actual = Buffer.from(provided.replace(/^sha256=/, ''), 'utf8');
	return expected.length === actual.length && timingSafeEqual(expected, actual);
});

/** The shape `Identity.Subject` decodes to, restated structurally so this module imports no identity. */
export type SystemSubject = Readonly<{
	readonly userId: string;
	readonly tenantId: string;
	readonly roles: ReadonlyArray<string>;
	readonly teams: ReadonlyArray<string>;
}>;

/**
 * The subject a verified signature runs as.
 *
 * Not an administrator. `admin` is deliberately absent, so `isAdministrator` is false and every
 * short-circuit it guards — `decide`, `rowPredicate`, `visibleApps`, `mayImpersonate` — stays shut.
 * The host's authority is the two grants `COLONY_SYSTEM_POLICY` enumerates and nothing else, which
 * is what makes "what can this credential do" a question with a written answer.
 *
 * `teams` is empty because a system principal approves nothing: `approvals.process` matches a step's
 * approvers against `subject.teams`, and inventing a membership would hand the host an approval
 * eligibility no workspace granted it.
 */
export const systemSubject = (tenantId: string): SystemSubject =>
	Object.freeze({
		userId: SYSTEM_PRINCIPAL_ID,
		tenantId,
		roles: [SYSTEM_PRINCIPAL_ROLE],
		teams: []
	});

export * as SystemPrincipal from './system-principal.js';
