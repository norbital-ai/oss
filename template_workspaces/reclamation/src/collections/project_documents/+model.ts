import { date, defineModel, enums, file, text, uuid } from '@norbital-ai/pod/authoring';

/**
 * Every other document a project carries.
 *
 * Two kinds live here and they behave differently. A `reconstruction` document
 * is read by the stitch hook and changes the model: an extra section sheet adds
 * profiles, an extra survey adds soundings. Everything else — tender returns,
 * correspondence, permits, method statements — is filed and never parsed.
 *
 * The three primary documents stay on the project itself. This collection is for
 * the fourth onwards.
 */
export default defineModel(
	{
		title: text().notNull(),
		project_id: uuid().notNull(),
		/** Whether the stitch reads this document, or it is filed for the record. */
		category: enums(['reconstruction', 'tender', 'reference']).notNull(),
		/**
		 * What a `reconstruction` document contributes. Ignored for the other
		 * categories, which are never parsed.
		 */
		document_role: enums(['additional_sections', 'additional_bathymetry', 'supporting']),
		document_file: file().notNull(),

		document_number: text(),
		discipline: text(),
		revision: text(),
		issued_on: date(),
		issued_by: text(),
		status: enums(['draft', 'issued', 'superseded', 'void']),
		tags: text().array(),
		notes: text()
	},
	{
		description:
			'Project documents beyond the three primaries: further reconstruction inputs that feed the stitch, and tender or reference material that is filed only.',
		recordLabel: 'title',
		icon: 'lucide:folder-open',
		indexes: [{ columns: ['project_id'] }, { columns: ['category'] }]
	}
);
