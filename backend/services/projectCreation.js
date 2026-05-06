import { v4 as uuidv4 } from 'uuid';
import { createProject, getProject } from '../convexClient.js';
import { seedProjectTemplatesFromAll } from './templateAdoption.js';

export function createProjectCreationService(customDeps = {}) {
  const deps = {
    uuidv4,
    createProject,
    getProject,
    seedProjectTemplatesFromAll,
    console,
    ...customDeps,
  };

  return async function createProjectWithTemplateSeeding(fields) {
    const id = fields.id || deps.uuidv4();
    await deps.createProject({
      id,
      name: fields.name,
      brand_name: fields.brand_name || '',
      niche: fields.niche || '',
      product_description: fields.product_description || '',
      sales_page_content: fields.sales_page_content || '',
      drive_folder_id: fields.drive_folder_id || '',
      inspiration_folder_id: fields.inspiration_folder_id || '',
    });

    let templateSeeding = { copied: 0, skipped: 0, failed: [], status: 'complete' };
    try {
      templateSeeding = await deps.seedProjectTemplatesFromAll(id);
    } catch (err) {
      deps.console.warn?.(`[Projects] Template seeding failed for new project ${id}: ${err.message}`);
      templateSeeding = {
        copied: 0,
        skipped: 0,
        failed: [{ error: err.message || 'Template seeding failed' }],
        status: 'failed',
      };
    }

    const project = await deps.getProject(id);
    return { project, templateSeeding };
  };
}

export const createProjectWithTemplateSeeding = createProjectCreationService();
