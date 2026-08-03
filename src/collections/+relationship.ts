import type { Relationships } from './$types.js';

export default ((r) => ({
	contractor_profiles: {
		job_assignment_contractor: r.many.job_assignments(),
		contractor_profile_certifications: r.many.certification_types({
			from: r.contractor_profiles.norbital_id.through(
				r.contractor_certifications.contractor_profile_id
			),
			to: r.certification_types.norbital_id.through(
				r.contractor_certifications.certification_type_id
			)
		})
	},
	certification_types: {
		contractor_profile_certifications: r.many.contractor_profiles(),
		job_required_certifications: r.many.jobs()
	},
	contractor_certifications: {
		contractor_certification_profile: r.one.contractor_profiles({
			from: r.contractor_certifications.contractor_profile_id,
			to: r.contractor_profiles.norbital_id
		}),
		contractor_certification_type: r.one.certification_types({
			from: r.contractor_certifications.certification_type_id,
			to: r.certification_types.norbital_id
		})
	},
	sites: {
		site_jobs: r.many.jobs()
	},
	jobs: {
		site_jobs: r.one.sites({
			from: r.jobs.site_id,
			to: r.sites.norbital_id
		}),
		job_assignment_job: r.many.job_assignments(),
		job_required_certifications: r.many.certification_types({
			from: r.jobs.norbital_id.through(r.job_certification_requirements.job_id),
			to: r.certification_types.norbital_id.through(
				r.job_certification_requirements.certification_type_id
			)
		})
	},
	job_certification_requirements: {
		job_certification_requirement_job: r.one.jobs({
			from: r.job_certification_requirements.job_id,
			to: r.jobs.norbital_id
		}),
		job_certification_requirement_type: r.one.certification_types({
			from: r.job_certification_requirements.certification_type_id,
			to: r.certification_types.norbital_id
		})
	},
	job_assignments: {
		job_assignment_job: r.one.jobs({
			from: r.job_assignments.job_id,
			to: r.jobs.norbital_id
		}),
		job_assignment_contractor: r.one.contractor_profiles({
			from: r.job_assignments.contractor_profile_id,
			to: r.contractor_profiles.norbital_id
		}),
		job_assignment_photo_evidence: r.many.photo_evidence(),
		job_assignment_variations: r.many.variation_requests()
	},
	variation_requests: {
		job_assignment_variations: r.one.job_assignments({
			from: r.variation_requests.job_assignment_id,
			to: r.job_assignments.norbital_id
		}),
		variation_request_photo_evidence: r.many.photo_evidence()
	},
	photo_evidence: {
		job_assignment_photo_evidence: r.one.job_assignments({
			from: r.photo_evidence.job_assignment_id,
			to: r.job_assignments.norbital_id
		}),
		variation_request_photo_evidence: r.one.variation_requests({
			from: r.photo_evidence.variation_request_id,
			to: r.variation_requests.norbital_id
		})
	}
})) satisfies Relationships;
