import {
	date,
	defineModel,
	enums,
	geolocation,
	integer,
	phone,
	text,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		name: text().notNull(),
		date_of_birth: date(),
		gender: enums(['MALE', 'FEMALE']),
		marital_status: enums(['SINGLE', 'MARRIED', 'DIVORCED', 'WIDOWED']),
		/**
		 * Whether the employee has a spouse, and whether that spouse has total income of their own.
		 *
		 * `marital_status` cannot answer this and every spouse relief turns on it: Malaysia's s.47
		 * relief and its MTD Category 2 scale both ask whether the spouse has income, not whether
		 * the employee is married. The two genuinely differ — a separated-but-not-divorced employee
		 * may record SINGLE while still supporting a spouse, and a married employee whose spouse
		 * works qualifies for neither. `null` means unrecorded, which is read as no relief.
		 */
		spouse_status: enums(['NONE', 'WITHOUT_INCOME', 'WITH_INCOME']),
		nationality: text(),
		identity_number: text(),
		dependents_count: integer().notNull().default(0),
		email: text(),
		phone: phone(),
		address: geolocation(),
		user_id: uuid()
	},
	{
		description:
			'A natural person. Holds only facts true of the human being — never of a job; everything employment-shaped lives on employments.',
		recordLabel: 'name',
		icon: 'lucide:user'
	}
);
