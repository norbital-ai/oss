/**
 * Every exact name an application capability may grant.
 *
 * Runtime access treats a path prefix as a group grant: `hr_controller` reaches
 * `hr_controller/leave` and every other app below that directory. Generated authoring types must
 * therefore include the same prefixes, while remaining a closed union that rejects misspellings.
 */
export const appCapabilityNames = (appNames: ReadonlyArray<string>): ReadonlyArray<string> =>
	[
		...new Set(
			appNames.flatMap((name) =>
				name.split('/').map((_, index, parts) => parts.slice(0, index + 1).join('/'))
			)
		)
	]
		.filter((name) => name.length > 0)
		.toSorted();
