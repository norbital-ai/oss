import { group } from '@norbital-ai/pod/authoring';

export default group({
	label: 'HR Controller',
	description:
		'Everything the HR team runs for one legal entity: people and their engagements, the roster and time behind a pay period, leave, loans, pay components, and the payroll runs that settle them.',
	icon: 'lucide:briefcase-business',
	defaultChild: 'people'
});
