// The protocol's version. HOST_API is one integer: it is bumped on any change a host or a release on the other side
// could misread, and on nothing else, so equal numbers interoperate whatever Bolt release answers.

/** The HOST_API this package describes. */
export const HOST_API_VERSION = 23;

/** Hosts and releases must speak this exact protocol. */
export const supports = (version: number): boolean => version === HOST_API_VERSION;
