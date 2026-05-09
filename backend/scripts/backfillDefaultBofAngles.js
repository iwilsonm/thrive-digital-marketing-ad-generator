#!/usr/bin/env node

const REQUIRED_HOST = 'cheery-cobra-258.convex.cloud';
const configuredUrl = process.env.CONVEX_URL || '';

let configuredHost = '';
try {
  configuredHost = new URL(configuredUrl).hostname;
} catch {
  configuredHost = '';
}

if (configuredHost !== REQUIRED_HOST) {
  console.error(`[backfillDefaultBofAngles] Refusing to run. Set CONVEX_URL=https://${REQUIRED_HOST}`);
  console.error(`[backfillDefaultBofAngles] Current CONVEX_URL host: ${configuredHost || '(missing/invalid)'}`);
  process.exit(1);
}

const [
  { getAllProjects, getDocsByProject, getConductorAngles, deleteConductorAngle },
  { seedDefaultBofAngleForProject, hasCompleteFoundationalDocs },
] = await Promise.all([
  import('../convexClient.js'),
  import('../services/bofSeeder.js'),
]);

function isArchived(project) {
  return typeof project.archived_at === 'string' && project.archived_at.trim().length > 0;
}

const startedAt = new Date().toISOString();
console.log(`[backfillDefaultBofAngles] started_at=${startedAt}`);
console.log(`[backfillDefaultBofAngles] convex_host=${configuredHost}`);

const projects = await getAllProjects();
const summary = {
  started_at: startedAt,
  convex_host: configuredHost,
  projects_seen: projects.length,
  projects_with_complete_docs: 0,
  seeded: 0,
  skipped_existing_bof: 0,
  skipped_missing_docs: 0,
  skipped_archived: 0,
  contaminants_deleted: 0,
  errors: [],
  actions: [],
};

for (const project of projects) {
  const projectId = project.id || project.externalId;
  const label = `${project.name || projectId} (${projectId})`;

  try {
    const [docs, angles] = await Promise.all([
      getDocsByProject(projectId),
      getConductorAngles(projectId),
    ]);

    const contaminants = angles.filter((angle) => (
      angle.source === 'system' && /^BOF\b/i.test(String(angle.name || ''))
    ));
    for (const angle of contaminants) {
      await deleteConductorAngle(angle.externalId);
      summary.contaminants_deleted += 1;
      console.log(`[backfillDefaultBofAngles] deleted_contaminant project="${label}" angle="${angle.name}" id=${angle.externalId}`);
    }
    const remainingAngles = angles.filter((angle) => !contaminants.some((deleted) => deleted.externalId === angle.externalId));

    if (isArchived(project)) {
      summary.skipped_archived += 1;
      summary.actions.push({ project_id: projectId, project_name: project.name, action: 'skipped_archived' });
      console.log(`[backfillDefaultBofAngles] skipped_archived project="${label}"`);
      continue;
    }

    if (!hasCompleteFoundationalDocs(docs)) {
      summary.skipped_missing_docs += 1;
      summary.actions.push({ project_id: projectId, project_name: project.name, action: 'skipped_missing_docs', docs: docs.length });
      console.log(`[backfillDefaultBofAngles] skipped_missing_docs project="${label}" docs=${docs.length}`);
      continue;
    }

    summary.projects_with_complete_docs += 1;
    const seedResult = await seedDefaultBofAngleForProject(project, docs, { existingAngles: remainingAngles });
    if (seedResult.created) {
      summary.seeded += 1;
      summary.actions.push({ project_id: projectId, project_name: project.name, action: 'seeded', angle: seedResult.name, id: seedResult.externalId });
      console.log(`[backfillDefaultBofAngles] seeded project="${label}" angle="${seedResult.name}" id=${seedResult.externalId}`);
    } else {
      summary.skipped_existing_bof += 1;
      summary.actions.push({ project_id: projectId, project_name: project.name, action: 'skipped_existing_bof', reason: seedResult.reason });
      console.log(`[backfillDefaultBofAngles] skipped_existing_bof project="${label}" reason=${seedResult.reason}`);
    }
  } catch (err) {
    summary.errors.push({ project_id: projectId, project_name: project.name, error: err.message });
    console.error(`[backfillDefaultBofAngles] error project="${label}" ${err.stack || err.message}`);
  }
}

summary.finished_at = new Date().toISOString();
console.log('[backfillDefaultBofAngles] summary_json=' + JSON.stringify(summary, null, 2));
process.exit(summary.errors.length > 0 ? 1 : 0);
