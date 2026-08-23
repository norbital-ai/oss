import { describe, expect, it } from 'vitest';
import { envoy, policy, workspace } from '../../src/authoring/workspace-schema.js';
import { buildSchemaPlan } from '../../src/compiler/schema-plan.js';
import {
	automationSubject,
	envoyPrincipalId,
	envoySubject,
	seedSubject,
	SEED_PRINCIPAL_ID
} from '../../src/runtime/identity/static-identity.js';
import {
	canonicalTransportIdentity,
	identitiesOf,
	identityMatches
} from '../../src/runtime/envoys/transport-identity.js';

const contractorEnvoy = () =>
	envoy({
		name: 'field_ops_whatsapp',
		transport: 'whatsapp',
		audience: 'authenticated',
		policies: ['contractor'],
		task: 'Answer a contractor about their own assignments.'
	});

const envoyWorkspace = (teams: Readonly<Record<string, ReadonlyArray<string>>> = {}) =>
	workspace({
		name: 'envoyed',
		version: '1',
		collections: [],
		apps: [],
		policies: [
			policy({
				name: 'contractor',
				effect: 'allow',
				actions: ['read'],
				capabilities: { apps: ['*'] }
			}),
			policy({ name: 'controller', effect: 'allow', actions: ['*'], capabilities: { apps: ['*'] } })
		],
		teams,
		prompt: 'You are the test workspace agent.',
		tools: [],
		skills: [],
		automations: [],
		envoys: [contractorEnvoy()],
		integrations: [],
		requiredFacilities: []
	});

describe('An envoy decides who answers, never what they may reach', () => {
	/**
	 * The invariant, asserted from both directions.
	 *
	 * An envoy's declared policies are the complete answer to what any turn on it may reach. Matching
	 * a sender to an account changes who the turn *is* — so that `${requestor.id}` narrows
	 * to their own rows — and must change nothing about capability. `policies` and `teamPath` are the
	 * only fields `AccessControl` resolves authority from, which is why they are what this asserts on.
	 */
	it('keeps the declared policies when a sender is matched to an account', () => {
		const bare = envoySubject(contractorEnvoy(), 'test-tenant', undefined);
		const linked = envoySubject(contractorEnvoy(), 'test-tenant', {
			userId: 'contractor-7',
			email: 'sam@example.com'
		});
		expect(linked.policies).toEqual(bare.policies);
		expect(linked.policies).toEqual(['contractor']);
		expect(linked.teamPath).toEqual([]);
		// Identity moved; capability did not.
		expect(linked.userId).toBe('contractor-7');
		expect(linked.email).toBe('sam@example.com');
	});

	/**
	 * The case that would be a real breach rather than a widening: `AccessControl` short-circuits on
	 * `subject.admin` before it consults a single policy, so an administrator's verified phone number
	 * carrying that flag onto an envoy would bypass the declared ceiling entirely.
	 */
	it('never carries an administrator flag, matched or not', () => {
		expect(envoySubject(contractorEnvoy(), 'test-tenant', { userId: 'boss-1' }).admin).toBe(false);
		expect(envoySubject(contractorEnvoy(), 'test-tenant', undefined).admin).toBe(false);
	});

	it('answers as its own principal when no sender was matched', () =>
		expect(envoySubject(contractorEnvoy(), 'test-tenant', undefined).userId).toBe(
			'envoy:field_ops_whatsapp'
		));

	/**
	 * **A static identity holds no team, and therefore can decide no approval.**
	 *
	 * `approvals.decide` matches a step's approvers against the subject's own team — `teamPath[0]` —
	 * so an empty path is what makes "an envoy can cause work that requires approval and can never be
	 * the one who grants it" a structural fact rather than a review comment.
	 */
	it('belongs to no team, so it is eligible to decide nothing', () => {
		for (const subject of [
			envoySubject(contractorEnvoy(), 'test-tenant', undefined),
			envoySubject(contractorEnvoy(), 'test-tenant', { userId: 'contractor-7' }),
			automationSubject({ name: 'payroll_close', policies: ['controller'] }, 'test-tenant'),
			seedSubject('test-tenant')
		]) {
			expect(subject.teamPath).toEqual([]);
			expect(subject.teamPath[0]).toBeUndefined();
		}
	});

	/**
	 * Two envoys on two transports are two identities and two ceilings.
	 *
	 * That is the whole reason one envoy is one transport rather than an agent with a list of them: a
	 * surface reachable by a different set of people should be separately revocable, and separately
	 * attributable in a history row.
	 */
	it('gives two envoys two distinct identities and two distinct ceilings', () => {
		const desk = envoySubject(
			{ name: 'sales_desk', policies: ['contractor'] },
			'test-tenant',
			undefined
		);
		const support = envoySubject(
			{ name: 'support_desk', policies: ['controller'] },
			'test-tenant',
			undefined
		);
		expect(desk.userId).not.toBe(support.userId);
		expect(desk.policies).not.toEqual(support.policies);
	});

	/**
	 * An envoy resolves against a policy a human team also holds, with no team of its own.
	 *
	 * This is the defect that shipped: the runtime resolved an envoy's authority by finding the team
	 * holding *exactly* its declared policy, so a workspace with no such team got no principal and
	 * the channel refused every message it ever received. `field-operations` shipped exactly that.
	 * Reuse is now the ordinary case — `sales_desk` naming `sales_rep` means the public desk does
	 * what a rep does — and it needs no team at all.
	 */
	it('carries its declared policies with no team behind them', () => {
		const definition = envoyWorkspace({ 'Contractor (Controller)': ['contractor', 'controller'] });
		const subject = envoySubject(definition.envoys[0]!, 'test-tenant', undefined);
		expect(subject.policies).toEqual(['contractor']);
		expect(subject.teamPath).toEqual([]);
	});

	/** The two fixed identities keep their names, because history rows already carry them. */
	it('names the seeder colony-seed and an envoy envoy:<name>', () => {
		expect(SEED_PRINCIPAL_ID).toBe('colony-seed');
		expect(envoyPrincipalId('field_ops_whatsapp')).toBe('envoy:field_ops_whatsapp');
	});
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
	 * than fail the read — one bad row must not take an envoy down. The sender is then simply
	 * unrecognised, which on an `authenticated` envoy is the same safe answer an unknown number gets.
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

describe('The schema plan builds the canonical greenfield schema', () => {
	it('creates channels directly on user', () => {
		const steps = buildSchemaPlan(envoyWorkspace()).steps;
		expect(steps.find((step) => step.id === 'collection:user')?.sql).toContain('"channels" jsonb');
	});

	it('creates envoy tables without compatibility steps', () => {
		const ids = buildSchemaPlan(envoyWorkspace()).steps.map(({ id }) => id);
		expect(ids.some((id) => id.includes('rename-from-channel'))).toBe(false);
		for (const created of [
			'collection:bolt_envoy_registrations',
			'collection:bolt_envoy_receipts',
			'collection:bolt_envoy_inbound'
		])
			expect(ids).toContain(created);
	});

	/**
	 * The two columns `conversation-selector.ts` has always read and nothing ever wrote.
	 *
	 * `chat_session` carried neither, so `visibility` was always `undefined`, the group bucket
	 * was permanently empty, and a public envoy's threads never reached the admin inbox they were
	 * routed to. A default of `personal` *is* the backfill: every conversation that already exists is
	 * a web-agent one.
	 */
	it('creates visibility and envoy_key on chat_session, defaulting to personal', () => {
		const steps = buildSchemaPlan(envoyWorkspace()).steps;
		const sql = steps.find(({ id }) => id === 'collection:chat_session')?.sql ?? '';
		expect(sql).toContain('"visibility" text default \'personal\' not null');
		expect(sql).toContain('"envoy_key" text');
	});
});
