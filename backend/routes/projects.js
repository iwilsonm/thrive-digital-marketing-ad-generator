import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { requireAuth, requireRole } from '../auth.js';
import {
  getProject,
  getProjectSummaries,
  getArchivedProjectSummaries,
  getProjectOptions,
  updateProject,
  archiveProject,
  unarchiveProject,
  getProjectStats,
  uploadBuffer,
  getStorageUrl,
  setProjectProductImage
} from '../convexClient.js';
import { createProjectWithTemplateSeeding } from '../services/projectCreation.js';

const imgUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

const EXT_TO_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};

const router = Router();
router.use(requireAuth);

// List all projects (single Convex query with embedded stats)
router.get('/', async (req, res) => {
  try {
    const projects = await getProjectSummaries();
    res.json(projects);
  } catch (err) {
    console.error('[Projects] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/options', async (req, res) => {
  try {
    const projects = await getProjectOptions();
    res.json({ projects });
  } catch (err) {
    console.error('[Projects] Options error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/archived', async (req, res) => {
  try {
    const projects = await getArchivedProjectSummaries();
    res.json({ projects });
  } catch (err) {
    console.error('[Projects] Archived list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get project stats
router.get('/:id/stats', async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const stats = await getProjectStats(project.id);
    res.json(stats);
  } catch (err) {
    console.error('[Projects] Stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get single project
router.get('/:id', async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // If the storage URL doesn't resolve (transient or stale storageId), report
    // null and let the user's natural workflow recover (re-upload via Project
    // Settings). The previous "self-heal" auto-cleared the field AND deleted
    // the blob on a single null result, which destroyed valid storageIds when
    // getStorageUrl had any transient hiccup. Removed in favor of explicit
    // surfacing.
    const productImageUrl = project.product_image_storageId
      ? await getStorageUrl(project.product_image_storageId).catch(() => null)
      : null;

    res.json({ ...project, productImageUrl });
  } catch (err) {
    console.error('[Projects] Get error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/archive', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    await archiveProject(req.params.id);
    const updated = await getProject(req.params.id);
    res.json({ success: true, project: updated });
  } catch (err) {
    console.error('[Projects] Archive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id/unarchive', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    await unarchiveProject(req.params.id);
    const updated = await getProject(req.params.id);
    res.json({ success: true, project: updated });
  } catch (err) {
    console.error('[Projects] Unarchive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create project
router.post('/', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, brand_name, niche, product_description, sales_page_content, drive_folder_id, inspiration_folder_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Project name is required' });

    const { project, templateSeeding } = await createProjectWithTemplateSeeding({
      name,
      brand_name: brand_name || '',
      niche: niche || '',
      product_description: product_description || '',
      sales_page_content: sales_page_content || '',
      drive_folder_id: drive_folder_id || '',
      inspiration_folder_id: inspiration_folder_id || ''
    });
    res.status(201).json({
      ...project,
      template_seeding: templateSeeding,
      template_seeding_warning: templateSeeding.failed.length > 0
        ? `${templateSeeding.failed.length} template${templateSeeding.failed.length === 1 ? '' : 's'} could not be copied.`
        : null,
    });
  } catch (err) {
    console.error('[Projects] Create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update project
router.put('/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    await updateProject(req.params.id, req.body);
    const updated = await getProject(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error('[Projects] Update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete project request maps to reversible archive. There is intentionally no
// hard-delete route in this iteration.
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    await archiveProject(req.params.id);
    const updated = await getProject(req.params.id);
    res.json({ success: true, project: updated });
  } catch (err) {
    console.error('[Projects] Archive via delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Upload / replace project product image
router.post('/:id/product-image', requireRole('admin', 'manager'), imgUpload.single('image'), async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });

  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    const mimeType = EXT_TO_MIME[ext] || 'application/octet-stream';

    const buffer = fs.readFileSync(req.file.path);
    const storageId = await uploadBuffer(buffer, mimeType);
    fs.unlinkSync(req.file.path);

    // This mutation also deletes the old image from storage
    await setProjectProductImage(req.params.id, storageId);

    const url = await getStorageUrl(storageId);
    res.json({ success: true, productImageUrl: url });
  } catch (err) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    console.error('[Projects] Product image upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete project product image
router.delete('/:id/product-image', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!project.product_image_storageId) {
      return res.json({ success: true });
    }

    // Pass undefined to clear; mutation handles storage deletion
    await setProjectProductImage(req.params.id, undefined);
    res.json({ success: true });
  } catch (err) {
    console.error('[Projects] Product image delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
