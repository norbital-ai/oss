import {
	custom,
	date,
	dateRange,
	defineModel,
	enums,
	text,
	uuid
} from '@norbital-ai/pod/authoring';

export default defineModel(
	{
		permit_number: text({ search: true }).notNull(),
		permit_type: enums([
			'work_at_height',
			'site_supervision',
			'electrical',
			'confined_space',
			'hot_work',
			'lifting',
			'excavation'
		]),
		project_id: uuid(),
		site_location_id: uuid(),
		job_id: uuid(),
		worker_id: uuid(),
		status: enums([
			'draft',
			'pending',
			'active',
			'expiring_soon',
			'expired',
			'suspended',
			'closed'
		]),
		requested_date: date(),
		validity_range: dateRange(),
		approved_by: text(),
		hazards_identified: text().array(),
		control_measures: text().array(),
		signatures: custom('permit_signatures')
	},
	{
		description: 'Evidence-backed permit and competency validity records.',
		recordLabel: 'permit_number',
		icon: 'lucide:shield-check',
		indexes: [{ columns: ['permit_number'], unique: true }]
	}
);
