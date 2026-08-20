import { describe, expect, it } from 'vitest';
import { channel, policy, workspace } from '../../src/authoring/index.js';
import { buildSchemaPlan } from '../../src/compiler/schema-plan.js';
import {
	channelPrincipalEmail,
	channelPrincipalTeam,
	channelSubject
} from '../../src/runtime/channels/channel-principal.js';
import {
	canonicalTransportIdentity,
	identitiesOf,
	identityMatches
} from '../../src/runtime/channels/transport-identity.js';
import type { Identity } from '../../src/runtime/identity/identity.js';

const contractorChannel = () =>
	channel({
		name: 'field_ops_whatsapp',
		transport: 'whatsapp',
		agent: 'field-assistant',
		audience: 'authenticated',
		policy: 'contractor',
		description: 'Field operations over WhatsApp',
		task: 'Answer a contractor about their own assignments.'
	});

const channelledWorkspace = (teams: Readonly<Record<string, ReadonlyArray<string>>>) =>
	workspace({
		name: 'channelled',
		version: '1',
		collections: [],
		apps: [],
		policies: [
			policy({ name: 'contractor', effect: 'allow', actions: ['read'], apps: ['*'] }),
			policy({ name: 'controller', effect: 'allow', actions: ['*'], apps: ['*'] })
		],
		teams,
		agents: [],
		automations: [],
		channels: [contractorChannel()],
		integrations: [],
		requiredFacilities: []
	});

/** A principal as `subjectByEmail` projects one: in a team, holding what that team declares. */
const principal: Identity.Subject = {
	userId: 'principal-1',
	tenantId: 'test-tenant',
	team: 'Contractor',
	teamPath: ['Contractor'],
	email: channelPrincipalEmail('field_ops_whatsapp'),
	admin: false
};

describe('Channel principals decide who answers, never what they may reach', () => {
	/**
	 * The invariant, asserted from both directions.
	 *
	 * A channel's declared policy is the complete answer to what any turn on it may reach. Matching a
	 * sender to an account changes who the turn *is* — so that `${requestor.norbital_id}` narrows to
	 * their own rows — and must change nothing about capability. These two fields are the only ones
	 * `AccessControl` resolves policies from, which is why they are what this asserts on.
	 */
	it('keeps the principal’s teams when a sender is matched to an account', () => {
		const linked = channelSubject(principal, { userId: 'contractor-7', email: 'sam@example.com' });
		expect(linked.teamPath).toEqual(principal.teamPath);
		expect(linked.team).toEqual(principal.team);
		// Identity moved; capability did not.
		expect(linked.userId).toBe('contractor-7');
		expect(linked.email).toBe('sam@example.com');
	});

	/**
	 * The case that would be a real breach rather than a widening: `AccessControl` short-circuits on
	 * `subject.admin` before it consults a single policy, so an administrator's verified phone number
	 * carrying that flag onto a channel would bypass the declared ceiling entirely.
	 */
	it('drops the administrator flag a matched account may carry elsewhere', () => {
		const asAdmin: Identity.Subject = { ...principal, admin: true };
		expect(channelSubject(asAdmin, { userId: 'boss-1' }).admin).toBe(false);
	});

	it('answers as the bare principal when no sender was matched', () =>
		expect(channelSubject(principal, undefined)).toEqual(principal));

	/**
	 * A superset team is the quiet failure this guards against. `policiesHeldByTeam` returns the union
	 * of a team's holdings and `rowPredicate` unions the `where` of every matching grant, so one
	 * unconditional grant beside a narrowed one collapses the predicate to `true` — and the channel
	 * would answer anybody with the whole workspace.
	 */
	it('chooses only a team holding exactly the declared policy', () => {
		const definition = channelledWorkspace({
			Contractor: ['contractor'],
			'Contractor (Controller)': ['contractor', 'controller']
		});
		expect(channelPrincipalTeam(definition, contractorChannel())).toBe('Contractor');
	});

	it('chooses no team at all rather than a superset of the declared policy', () => {
		const definition = channelledWorkspace({
			'Contractor (Controller)': ['contractor', 'controller']
		});
		// Undefined is the point: `receive` refuses the message and runs no model, which is the only
		// safe reading of a workspace that never said what its channel may do.
		expect(channelPrincipalTeam(definition, contractorChannel())).toBeUndefined();
	});

	it('gives a principal an address that can never be delivered to or collide with a person', () =>
		expect(channelPrincipalEmail('field_ops_whatsapp')).toBe(
			'channel+field_ops_whatsapp@channels.invalid'
		));
});

describe('Transport identities recognise a sender without granting them anything', () => {
	it('reads a WhatsApp JID and a typed number as the same address', () =>
		expect(canonicalTransportIdentity('whatsapp', '6591234567@s.whatsapp.net')).toBe(
			canonicalTransportIdentity('whatsapp', '+65 9123 4567')
		));

	it('keeps two different numbers apart', () =>
		expect(canonicalTransportIdentity('whatsapp', '+65 9123 4567')).not.toBe(
			canonicalTransportIdentity('whatsapp', '+65 9123 4568')
		));

	it('folds case for a handle-shaped transport', () =>
		expect(canonicalTransportIdentity('telegram', '@Alice')).toBe(
			canonicalTransportIdentity('telegram', 'alice')
		));

	/**
	 * An unproven claim is inert. An administrator recording somebody's number is not the same fact
	 * as that person having proved it is theirs, and only the second one may identify a sender.
	 */
	it('refuses to match an identity that was never verified', () =>
		expect(
			identityMatches(
				{ type: 'whatsapp', address: '+65 9123 4567', verified: false },
				'whatsapp',
				'6591234567@s.whatsapp.net'
			)
		).toBe(false));

	it('refuses to match a verified identity on a different transport', () =>
		expect(
			identityMatches(
				{ type: 'telegram', address: '6591234567', verified: true },
				'whatsapp',
				'6591234567'
			)
		).toBe(false));

	/**
	 * The column is `jsonb` and nothing constrains it, so a malformed entry has to drop out rather
	 * than fail the read — one bad row must not take a channel down. The sender is then simply
	 * unrecognised, which on an `authenticated` channel is the same safe answer an unknown number
	 * gets.
	 */
	it('ignores malformed entries instead of failing the lookup', () =>
		expect(
			identitiesOf([
				{ type: 'whatsapp', address: '+6591234567', verified: true },
				{ type: 'whatsapp', verified: true },
				'not an object',
				null
			])
		).toEqual([{ type: 'whatsapp', address: '+6591234567', verified: true }]));

	it('reads a column that is not an array as holding nothing', () =>
		expect(identitiesOf(undefined)).toEqual([]));

	/**
	 * Two addresses that reduce to nothing are not the same address.
	 *
	 * Canonicalisation strips an address to its identifying part, so anything with none of one — a
	 * handle that was only a sigil, a "number" carrying no digits — reduces to the empty string. If
	 * matching compared those by equality, one malformed stored identity would match *any* malformed
	 * sender and hand them that account. This is the case that says it must not.
	 */
	it('never matches two addresses that both reduce to nothing', () => {
		expect(canonicalTransportIdentity('whatsapp', '+++')).toBe('');
		expect(
			identityMatches({ type: 'whatsapp', address: '+++', verified: true }, 'whatsapp', '@@@')
		).toBe(false);
	});

	it('keeps a handle that is only a sigil from becoming an empty identity', () =>
		expect(canonicalTransportIdentity('telegram', '@alice')).toBe('alice'));
});

describe('The schema plan orders the identity column after the table it lands on', () => {
	/**
	 * `buildSchemaPlan` sorts every step by id, so an `alter table bolt_auth_user` step named
	 * `bolt:…` would sort ahead of `collection:bolt_auth_user` — the step that creates the table —
	 * and a fresh provision would fail on a relation that does not exist yet. The id is the ordering,
	 * so the ordering is what this asserts.
	 */
	it('applies the channels column after bolt_auth_user is created', () => {
		const steps = buildSchemaPlan(channelledWorkspace({ Contractor: ['contractor'] })).steps;
		const table = steps.findIndex((step) => step.id === 'collection:bolt_auth_user');
		const column = steps.findIndex(
			(step) => step.id === 'collection:bolt_auth_user:column:channels'
		);
		expect(table).toBeGreaterThanOrEqual(0);
		expect(column).toBeGreaterThan(table);
	});

	it('creates the column jsonb, matching what field.json renders', () => {
		const steps = buildSchemaPlan(channelledWorkspace({ Contractor: ['contractor'] })).steps;
		expect(
			steps.find((step) => step.id === 'collection:bolt_auth_user:column:channels')?.sql
		).toContain('channels jsonb');
	});
});
