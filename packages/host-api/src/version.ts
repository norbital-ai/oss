// The protocol's version. HOST_API is one integer: it is bumped on any change a host or a release on the other side
// could misread, and on nothing else, so equal numbers interoperate whatever Bolt release answers.

/** The HOST_API this package describes. */
export const HOST_API_VERSION = 22;

/** The HOST_API versions a host serves, both ends included. */
export type HostApiRange = { readonly from: number; readonly to: number };

/** Whether a release speaking HOST_API `version` may be served by a host serving `range`. */
export const supports = (range: HostApiRange, version: number): boolean =>
	Number.isInteger(version) && version >= range.from && version <= range.to;
