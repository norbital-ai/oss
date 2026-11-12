/** Native facility crossing names, shared by boundary validation, dispatch types and guest context construction. */
export const FACILITY_MEMBERS = [
	'web.read',
	'browser.navigate',
	'browser.snapshot',
	'browser.act',
	'browser.evaluate',
	'browser.download',
	'browser.close',
	'files.meta',
	'files.get',
	'files.url',
	'files.image',
	'files.put',
	'convert.document',
	'convert.ingest',
	'ai.sys_1.decide',
	'ai.sys_2.infer',
	'ai.embed',
	'geo.search',
	'geo.reverse'
] as const;
export type FacilityMember = (typeof FACILITY_MEMBERS)[number];
