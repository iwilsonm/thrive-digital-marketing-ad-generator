#!/usr/bin/env node

const REQUIRED_HOST = 'cheery-cobra-258.convex.cloud';
const CCW_PROJECT_ID = '526cdad9-fc79-48ef-9657-726f3a6c4a3c';
const LEGACY_HEADLINE_ANGLES = ['BOF (Bottom of Funnel)', 'BOF - Discernment Before Commitment'];

const configuredUrl = process.env.CONVEX_URL || '';

let configuredHost = '';
try {
  configuredHost = new URL(configuredUrl).hostname;
} catch {
  configuredHost = '';
}

if (configuredHost !== REQUIRED_HOST) {
  console.error(`[backfillDirectOfferAngles] Refusing to run. Set CONVEX_URL=https://${REQUIRED_HOST}`);
  console.error(`[backfillDirectOfferAngles] Current CONVEX_URL host: ${configuredHost || '(missing/invalid)'}`);
  process.exit(1);
}

const [
  { getAllProjects, getDocsByProject, getConductorAngles, deleteConductorAngle, clearHeadlineHistoryByAngle },
  { seedDirectOfferAngleForProject, hasCompleteFoundationalDocs },
] = await Promise.all([
  import('../convexClient.js'),
  import('../services/directOfferSeeder.js'),
]);

function isArchived(project) {
  return typeof project.archived_at === 'string' && project.archived_at.trim().length > 0;
}

function isLegacyOfferAngle(angle) {
  const name = String(angle?.name || '');
  return angle?.source === 'system'
    || angle?.source === 'default_bof'
    || /^BOF\b/i.test(name);
}

const startedAt = new Date().toISOString();
console.log(`[backfillDirectOfferAngles] started_at=${startedAt}`);
console.log(`[backfillDirectOfferAngles] convex_host=${configuredHost}`);

const projects = await getAllProjects();
const summary = {
  started_at: startedAt,
  convex_host: configuredHost,
  projects_seen: projects.length,
  projects_with_complete_docs: 0,
  seeded: 0,
  skipped_existing_direct_offer: 0,
  skipped_missing_docs: 0,
  skipped_archived: 0,
  legacy_angles_deleted: 0,
  legacy_headline_history_deleted: 0,
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

    const legacyAngles = angles.filter(isLegacyOfferAngle);
    for (const angle of legacyAngles) {
      await deleteConductorAngle(angle.externalId);
      summary.legacy_angles_deleted += 1;
      console.log(`[backfillDirectOfferAngles] deleted_legacy_angle project="${label}" angle="${angle.name}" source=${angle.source || ''} id=${angle.externalId}`);
    }
    const remainingAngles = angles.filter((angle) => !legacyAngles.some((deleted) => deleted.externalId === angle.externalId));

    if (projectId === CCW_PROJECT_ID) {
      for (const angleName of LEGACY_HEADLINE_ANGLES) {
        const result = await clearHeadlineHistoryByAngle(projectId, angleName);
        summary.legacy_headline_history_deleted += result.deleted || 0;
        console.log(`[backfillDirectOfferAngles] cleared_legacy_headline_history project="${label}" angle="${angleName}" deleted=${result.deleted || 0}`);
      }
    }

    if (isArchived(project)) {
      summary.skipped_archived += 1;
      summary.actions.push({ project_id: projectId, project_name: project.name, action: 'skipped_archived' });
      console.log(`[backfillDirectOfferAngles] skipped_archived project="${label}"`);
      continue;
    }

    if (!hasCompleteFoundationalDocs(docs)) {
      summary.skipped_missing_docs += 1;
      summary.actions.push({ project_id: projectId, project_name: project.name, action: 'skipped_missing_docs', docs: docs.length });
      console.log(`[backfillDirectOfferAngles] skipped_missing_docs project="${label}" docs=${docs.length}`);
      continue;
    }

    summary.projects_with_complete_docs += 1;
    const seedResult = await seedDirectOfferAngleForProject(project, docs, { existingAngles: remainingAngles });
    if (seedResult.created) {
      summary.seeded += 1;
      summary.actions.push({ project_id: projectId, project_name: project.name, action: 'seeded', angle: seedResult.name, id: seedResult.externalId });
      console.log(`[backfillDirectOfferAngles] seeded project="${label}" angle="${seedResult.name}" id=${seedResult.externalId}`);
    } else {
      summary.skipped_existing_direct_offer += 1;
      summary.actions.push({ project_id: projectId, project_name: project.name, action: 'skipped_existing_direct_offer', reason: seedResult.reason });
      console.log(`[backfillDirectOfferAngles] skipped_existing_direct_offer project="${label}" reason=${seedResult.reason}`);
    }
  } catch (err) {
    summary.errors.push({ project_id: projectId, project_name: project.name, error: err.message });
    console.error(`[backfillDirectOfferAngles] error project="${label}" ${err.stack || err.message}`);
  }
}

summary.finished_at = new Date().toISOString();
console.log('[backfillDirectOfferAngles] summary_json=' + JSON.stringify(summary, null, 2));
process.exit(summary.errors.length > 0 ? 1 : 0);
