/**
 * Catalog lookups for the reclamation engine's label maps.
 *
 * The engine keeps its English labels and notes in the substrate register and
 * the solid's surface table — they are data, read off the model and written
 * into stored reports. Components render them through this module: each lookup
 * tries the tenant catalog key first (so a zh viewer sees zh) and falls back
 * to the stored value when a key does not exist yet, which keeps newly added
 * engine labels from ever rendering blank.
 */

import type { I18nApi } from '@norbital-ai/ui/i18n';
import type { TenantI18nKeys } from '$pod/i18n-keys';

export type I18n = I18nApi<TenantI18nKeys>;

/** Translate a catalog key when the catalog has it, else return the fallback. */
export function pick(i18n: I18n | undefined, key: string, fallback: string): string {
	return i18n !== undefined && i18n.has(key) ? i18n.t(key as TenantI18nKeys) : fallback;
}

export function substrateLabel(i18n: I18n | undefined, id: string, fallback: string): string {
	return pick(i18n, `recon.substrate.${id}.label`, fallback);
}

export function substrateNote(i18n: I18n | undefined, id: string, fallback: string): string {
	return pick(i18n, `recon.substrate.${id}.note`, fallback);
}

export function manualTakeOffLabel(i18n: I18n | undefined, id: string, fallback: string): string {
	return pick(i18n, `recon.manual.${id}.label`, fallback);
}

export function manualTakeOffWhy(i18n: I18n | undefined, id: string, fallback: string): string {
	return pick(i18n, `recon.manual.${id}.why`, fallback);
}

export function surfaceLabel(i18n: I18n | undefined, id: string, fallback: string): string {
	return pick(i18n, `recon.surface.${id}.label`, fallback);
}

export function surfaceNote(i18n: I18n | undefined, id: string, fallback: string): string {
	return pick(i18n, `recon.surface.${id}.note`, fallback);
}

export function methodLabel(i18n: I18n | undefined, method: string, fallback: string): string {
	return pick(i18n, `recon.method.${method}`, fallback);
}

export function driverLabel(i18n: I18n | undefined, driver: string, fallback: string): string {
	return pick(i18n, `recon.driver.${driver}`, fallback);
}
