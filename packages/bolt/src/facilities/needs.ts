// What a bundle needs from its host (plan 01): derived from the declarations at build and recorded in the manifest.
// Never config, never secrets. The check is the only gate: an unmet need refuses activation, naming it.
import type { EngineManifest } from '../engine/manifest.ts';
import type { Facilities } from './index.ts';
import { isOff } from './off.ts';

/** Every facility member a host may leave `off`, each a need some declaration can record. */
export const NEEDS = [
	'sms',
	'phone',
	'push',
	'challenge',
	'system1',
	'system2',
	'embed',
	'speech',
	'webhooks',
	'websockets',
	'outbound',
	'sandbox'
] as const;
export type Need = (typeof NEEDS)[number];

const hasWebhookTrigger = (on: unknown): boolean =>
	Array.isArray(on)
		? on.some(hasWebhookTrigger)
		: typeof on === 'object' && on !== null && 'webhook' in on;

type Manifest = Omit<EngineManifest, 'needs'>;
const integrations = (m: Manifest) =>
	Object.keys(m.integrations).length > 0 || Object.keys(m.connections).length > 0;
/**
 * Which declarations need each member. Push, speech, websockets and the sandbox are reached only from guest code or
 * provider internals, which no declaration records: a notice still reaches the inbox without push, and an unsupported
 * call answers Unavailable at run time.
 */
const NEEDED: { readonly [N in Need]: (m: Manifest) => boolean } = {
	// a phone sign-up sends its code by `phone` and texts invitations by `sms`
	sms: (m) => m.workspace.signup?.via.includes('phone') === true,
	phone: (m) => m.workspace.signup?.via.includes('phone') === true,
	push: () => false,
	challenge: (m) =>
		Object.values(m.apps).some(
			(app) => typeof app.audience === 'object' && app.audience.challenge === 'turnstile'
		),
	system1: (m) => m.workspace.ai !== undefined,
	system2: (m) => m.workspace.ai !== undefined,
	embed: (m) => (m.workspace.ai?.embeddings?.length ?? 0) > 0,
	speech: () => false,
	webhooks: (m) =>
		integrations(m) || Object.values(m.automations).some((a) => hasWebhookTrigger(a.on)),
	websockets: () => false,
	outbound: (m) => integrations(m) || Object.keys(m.workspace.secrets ?? {}).length > 0,
	sandbox: () => false
};

/** The needs of a decoded manifest, in `NEEDS` order. */
export const needsOf = (m: Manifest): readonly Need[] => NEEDS.filter((need) => NEEDED[need](m));

/** The part of a `Facilities` record the needs check reads: the groups whose members may be `off`. */
export type Checked = Pick<Facilities, 'transactional' | 'intelligence' | 'ports' | 'sandbox'>;
/** The facility member each need reads. */
const member = (f: Checked, need: Need): object => {
	switch (need) {
		case 'sms':
		case 'phone':
		case 'push':
		case 'challenge':
			return f.transactional[need];
		case 'system1':
		case 'system2':
		case 'embed':
		case 'speech':
			return f.intelligence[need];
		case 'webhooks':
		case 'websockets':
		case 'outbound':
			return f.ports[need];
		case 'sandbox':
			return f.sandbox;
	}
};
/**
 * Every member `facilities` leaves `off` that the bundle needs. `mail` is needed by every bundle: its type has no `off`,
 * and a record built around the type (a JavaScript host) is refused here too.
 */
export const unmet = (needs: readonly Need[], f: Checked): readonly (Need | 'mail')[] => [
	...(isOff(f.transactional.mail) ? (['mail'] as const) : []),
	...needs.filter((need) => isOff(member(f, need)))
];
