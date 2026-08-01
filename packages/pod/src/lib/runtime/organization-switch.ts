/**
 * Make another organization canonical, then ask Core for a new document.
 *
 * A tenant's browser entry imports that tenant's compiled app modules, collection surfaces and
 * custom renderers. Those modules cannot be converted into another tenant's bundle by clearing
 * client caches or remounting the component tree. Core is the authority that resolves the active
 * organization to one coherent bundle, manifest, identity and database, so every switch crosses
 * that boundary with a document navigation.
 */
/**
 * Whether a switch is under way, so the shell can stop rendering the organization being left.
 *
 * Covering the old workspace with an overlay is not enough. The request has to reach Core, Core has
 * to warm the target runtime, and only then does the document navigate — for that whole window the
 * previous organization's records are still mounted underneath, and a translucent overlay leaves
 * them legible. Whatever is showing during a switch must be the destination or nothing; one
 * organization's rows must never be readable while another organization's name is on the screen.
 */
let switching = $state(false);

export function isSwitchingOrganization(): boolean {
	return switching;
}

export async function switchOrganization(organizationId: string): Promise<void> {
	switching = true;
	try {
		const response = await fetch('/api/organizations/switch', {
			method: 'POST',
			credentials: 'include',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ organizationId })
		});
		if (!response.ok) throw new Error('Unable to switch workspace');
	} catch (error) {
		// The switch failed, so this document keeps serving the organization it already had.
		switching = false;
		throw error;
	}

	// Replace rather than push: Back must not resurrect a route from the organization just left.
	window.location.replace('/');
}
