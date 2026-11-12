/** Public option names retain the vendor's exact value types at the component boundary. */
export type SnakeProps<P, M extends Readonly<Record<string, keyof P>>> = P extends object ? Omit<P, M[keyof M]> & {
	[K in keyof M]?: P[M[K]];
} : never;
