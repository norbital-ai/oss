import type { Relationships } from './$types.js';

export default ((r) => ({
	reclamation_projects: {
		reconstructions_projects: r.many.site_reconstructions(),
		estimates_projects: r.many.cost_estimates(),
		documents_projects: r.many.project_documents()
	},
	project_documents: {
		documents_projects: r.one.reclamation_projects({
			from: r.project_documents.project_id,
			to: r.reclamation_projects.norbital_id
		})
	},
	site_reconstructions: {
		reconstructions_projects: r.one.reclamation_projects({
			from: r.site_reconstructions.project_id,
			to: r.reclamation_projects.norbital_id
		}),
		estimates_reconstructions: r.many.cost_estimates()
	},
	cost_estimates: {
		estimates_projects: r.one.reclamation_projects({
			from: r.cost_estimates.project_id,
			to: r.reclamation_projects.norbital_id
		}),
		estimates_reconstructions: r.one.site_reconstructions({
			from: r.cost_estimates.reconstruction_id,
			to: r.site_reconstructions.norbital_id
		})
	}
})) satisfies Relationships;
