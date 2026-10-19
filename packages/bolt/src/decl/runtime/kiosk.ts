import { Option } from 'effect';
import { audienceAdmits } from './app.ts';
// A kiosk (§3.3.1): a standalone chromeless surface rooted at `src/kiosk/<name>/`, outside `src/app/`.
// A kiosk is always chromeless (no sidebar, banner, tabs or agent) and served at `/kiosk/<name>/<page>`,
// so it never needs a `portal` flag on its pages. Who may open it is `auth`: a signed-in audience
// (`members`, `external`, `all`) or `'none'` for no authentication at all. What it may do inside is
// `policies`: the assigned policies it runs as, envoy-style — an override of the requestor's own rights,
// so a public kiosk whose requestor holds no policy still reads and writes through its assigned policy.
// A member kiosk still needs opening rights: a held policy's `capabilities.kiosks` naming it (or an
// administrator); the inside authority is always the kiosk's own policies with no admin bypass.
import type { Checked, Exact } from '../fields.ts';
import type { KioskName, PolicyName } from '../names.ts';
import type { IconName, Msg, NonEmpty } from '../values.ts';
import type { KioskPageName } from './names.ts';

type KioskAuth = 'members' | 'external' | 'all' | 'none';
type KioskPage = { title: Msg; icon?: IconName };
export type KioskSpec = {
	title: Msg;
	description: Msg;
	icon: IconName;
	/** The kiosk card image, an asset path. */
	banner?: string;
	/** Who may open it: a signed-in audience, or `'none'` for no authentication (default `'members'`). */
	auth?: KioskAuth;
	/** The assigned policies it runs as inside (envoy-style override, never an admin bypass). */
	policies: NonEmpty<string>;
	/** The kiosk's pages by file name, in nav order: a title and icon each. */
	pages: { readonly [page: string]: KioskPage };
};
type KioskFor<K> = {
	title: Msg;
	description: Msg;
	icon: IconName;
	banner?: string;
	auth?: KioskAuth;
	policies: NonEmpty<PolicyName>;
	/** Key order is nav order; every page file needs an entry (build `kiosk/page-unlisted`). */
	pages: { [P in KioskPageName<K>]?: KioskPage };
};

/**
 * `src/kiosk/<k>/+kiosk.ts`: a standalone kiosk's title, description, icon and banner, who may open it
 * (`auth`), the policies it runs as inside (`policies`), and its pages in nav order (each
 * `+<page>.page.svelte` in the folder needs an entry).
 * @example
 * export default kiosk('clock', {
 * 	title: 'app.kiosk.title',
 * 	description: 'app.kiosk.description',
 * 	icon: 'lucide:clock',
 * 	auth: 'none',
 * 	policies: ['kiosk_clock'],
 * 	pages: { clock: { title: 'app.kiosk.clock', icon: 'lucide:clock' } }
 * });
 */
export function kiosk<const K extends KioskName, const S extends KioskSpec>(
	name: K,
	spec: S & Checked<KioskSpec, S, Exact<S, KioskFor<K>>>
): { readonly name: K; readonly spec: S } {
	return { name, spec };
}

/** The decoded manifest's kiosk authority, absent for an unknown kiosk. */
export const kioskOf: import('../../engine/services.ts').KioskOf = (m, name) => {
	const spec = m.kiosks?.[name];
	return spec === undefined
		? Option.none()
		: Option.some({ auth: spec.auth ?? 'members', policies: spec.policies });
};
export const canOpenKiosk: import('../../engine/services.ts').CanOpenKiosk = (
	m,
	name,
	authority
) => {
	const spec = m.kiosks?.[name];
	if (spec === undefined) return false;
	if ((spec.auth ?? 'members') === 'none') return true;
	if (authority.actor.kind !== 'member') return false;
	return (
		authority.admin ||
		(audienceAdmits(spec.auth ?? 'members', authority) &&
			(authority.capabilities.kiosks ?? []).some((k) => k === '*' || k === name))
	);
};
