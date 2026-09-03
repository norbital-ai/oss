/**
 * Tiny authored in-memory fixture shared by Colony and host-contract tests.
 * No product vocabulary — notes, not payroll or field assignments.
 */
export const simpleWorkspace = {
	stages: ['notes'],
	rows: {
		notes: [{ id: 'note-1', body: 'hello' }]
	}
} as const;
