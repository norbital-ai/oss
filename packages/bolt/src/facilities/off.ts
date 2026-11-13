// `off`: the one way a host leaves a facility member out (plan 01). It is a value, so it crosses HOST_API's module graphs
// by its tag, never by identity.
/** The marker a host passes in place of a facility member it does not provide; that member then fails `unavailable`. */
export const off = { _tag: 'Off' } as const;
export type Off = typeof off;
/** Whether a facility member is `off`, by its tag (never by identity, so it holds across module graphs). */
export const is_off = (value: object): value is Off => '_tag' in value && value._tag === 'Off';
