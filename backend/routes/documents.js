import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth.js';
import { getProject, getLatestDoc, updateProject, invalidateQueryCache } from '../convexClient.js';
import { convexClient, api } from '../convexClient.js';
import {
  regenerateDoc,
  generateFromManualResearch,
  findAndCorrectDocs,
  STEPS,
  prompt1_AnalyzeSalesPage,
  prompt2_ResearchMethodology,
  prompt3_GenerateResearchPrompt
} from '../services/docGenerator.js';
import { getHistory, logManualEdit, applyCorrections, revertCorrection } from '../services/correctionHistory.js';
import { streamService } from '../utils/sseHelper.js';
import { seedDirectOfferAngleForProject } from '../services/directOfferSeeder.js';

const router = Router();
router.use(requireAuth);
const DOC_TYPES = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];

// Check if all 4 doc types exist and promote status to 'docs_ready' if so.
// Only promotes from 'setup' — never demotes or interferes with 'generating_docs'.
async function checkAndPromoteDocStatus(projectId) {
  try {
    const project = await getProject(projectId);
    if (!project) return;
    const docs = await Promise.all(DOC_TYPES.map(type => getLatestDoc(projectId, type)));
    const allDocsExist = docs.every(Boolean);

    // Promote status from setup to docs_ready
    if (project.status === 'setup' && allDocsExist) {
      await updateProject(projectId, { status: 'docs_ready' });
    }

    if (allDocsExist) {
      try {
        await seedDirectOfferAngleForProject(project, docs);
      } catch (seedErr) {
        console.error('[Docs] Direct Offer seed error:', seedErr.message);
      }
    }
  } catch (err) {
    console.error('[Docs] Status check error:', err.message);
  }
}

// List all docs for a project
router.get('/:projectId/docs', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const docs = await Promise.all(
      DOC_TYPES.map(type => getLatestDoc(req.params.projectId, type))
    );

    // Auto-heal: promote status if all docs exist but status is stuck at 'setup'
    if (project.status === 'setup') {
      const allPresent = docs.every(Boolean);
      if (allPresent) {
        updateProject(req.params.projectId, { status: 'docs_ready' }).catch(() => {});
      }
    }

    res.json({
      docs: docs.filter(Boolean),
      steps: STEPS.map(s => ({ id: s.id, label: s.label, savedAs: s.savedAs, mode: s.mode }))
    });
  } catch (err) {
    console.error('[Docs] List docs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Remove all foundational docs for a project
router.delete('/:projectId/docs', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const result = await convexClient.mutation(api.foundationalDocs.removeByProject, {
      projectId: req.params.projectId,
    });

    invalidateQueryCache('foundational_docs');

    // Once the source docs are gone, the project should clearly return to setup.
    await updateProject(req.params.projectId, { status: 'setup' });
    invalidateQueryCache('foundational_docs');

    res.json({
      success: true,
      deleted: result?.deleted || 0,
      status: 'setup',
    });
  } catch (err) {
    console.error('[Docs] Remove all docs error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to remove foundational documents' });
  }
});

// Get pre-populated research prompts for manual research flow
router.get('/:projectId/research-prompts', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const prompts = [
      {
        step: 1,
        title: 'Step 1: Analyze Your Sales Page',
        instruction: 'Start a new conversation in ChatGPT or Claude and paste the prompt below. The product description you provided when creating this project is already included in the prompt — no attachment needed.',
        alert: 'Make sure you insert the description of your product before running this prompt.',
        prompt: prompt1_AnalyzeSalesPage(
          project.product_description,
          project.sales_page_content
        )
      },
      {
        step: 2,
        title: 'Step 2: Teach the Research Methodology',
        instruction: 'After getting the response from Step 1, send this second prompt in the SAME conversation. This teaches the AI the deep research methodology with a fully worked example.',
        prompt: prompt2_ResearchMethodology()
      },
      {
        step: 3,
        title: 'Step 3: Generate Your Research Prompt',
        instruction: 'After getting the response from Step 2, send this third prompt in the SAME conversation. This does not complete the research; it creates the detailed prompt you will use in Step 4.',
        prompt: prompt3_GenerateResearchPrompt(project.name)
      },
      {
        step: 4,
        title: 'Step 4: Run Deep Research',
        mode: 'instruction',
        instruction: 'Take the research prompt generated in Step 3, open ChatGPT in your web browser, turn on Deep Research, paste the prompt, and run it. When Deep Research finishes, copy the full research output into a Google Doc, save it as a PDF, and return here to upload it.'
      }
    ];

    res.json({ prompts });
  } catch (err) {
    console.error('[Docs] Research prompts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Upload existing foundational documents directly (bypass all generation)
router.post('/:projectId/upload-docs', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { docs } = req.body;
    if (!docs || typeof docs !== 'object') {
      return res.status(400).json({ error: 'docs object is required' });
    }

    const validTypes = DOC_TYPES;
    const saved = [];

    for (const [docType, content] of Object.entries(docs)) {
      if (!validTypes.includes(docType)) continue;
      if (!content || content.trim().length === 0) continue;

      const existing = await getLatestDoc(req.params.projectId, docType);
      const version = existing ? existing.version + 1 : 1;
      const id = uuidv4();

      await convexClient.mutation(api.foundationalDocs.create, {
        externalId: id,
        project_id: req.params.projectId,
        doc_type: docType,
        content: content.trim(),
        version,
        source: 'uploaded',
      });
      invalidateQueryCache('foundational_docs');

      saved.push({ id, doc_type: docType, version });
    }

    if (saved.length === 0) {
      return res.status(400).json({ error: 'No documents with content were provided' });
    }

    // Promote status if all 4 doc types now exist
    await checkAndPromoteDocStatus(req.params.projectId);

    res.json({ saved, count: saved.length });
  } catch (err) {
    console.error('[Docs] Upload docs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate synthesis docs from manually-uploaded research (SSE streaming)
router.post('/:projectId/generate-docs-manual', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { researchContent } = req.body;
  if (!researchContent || researchContent.trim().length === 0) {
    return res.status(400).json({ error: 'Research content is required' });
  }

  streamService(req, res, (sendEvent) =>
    generateFromManualResearch(req.params.projectId, researchContent.trim(), sendEvent)
  );
});

// Regenerate a single doc type (SSE streaming)
router.post('/:projectId/generate-doc/:type', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const validTypes = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];
  if (!validTypes.includes(req.params.type)) {
    return res.status(400).json({ error: `Invalid doc type. Must be one of: ${validTypes.join(', ')}` });
  }

  streamService(req, res, async (sendEvent) => {
    await regenerateDoc(req.params.projectId, req.params.type, sendEvent);
    await checkAndPromoteDocStatus(req.params.projectId);
  });
});

// Update doc content (manual edit) — also logs to correction history
router.put('/:projectId/docs/:docId', async (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'Content is required' });

  try {
    const beforeDoc = await convexClient.query(api.foundationalDocs.getByExternalId, { externalId: req.params.docId });
    if (!beforeDoc) return res.status(404).json({ error: 'Document not found' });
    const beforeContent = beforeDoc.content || '';

    await convexClient.mutation(api.foundationalDocs.update, {
      externalId: req.params.docId,
      content,
    });
    const doc = await convexClient.query(api.foundationalDocs.getByExternalId, { externalId: req.params.docId });

    // Fire-and-forget history logging
    if (beforeContent !== content) {
      logManualEdit(req.params.projectId, doc.externalId, beforeContent, content, doc.doc_type)
        .catch(err => console.error('[Changelog] Failed to log manual edit:', err.message));
    }

    // Promote status if all docs now exist
    checkAndPromoteDocStatus(req.params.projectId).catch(() => {});

    res.json({
      id: doc.externalId,
      project_id: doc.project_id,
      doc_type: doc.doc_type,
      content: doc.content,
      version: doc.version,
      approved: doc.approved ? 1 : 0,
      source: doc.source,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    });
  } catch (err) {
    res.status(404).json({ error: 'Document not found' });
  }
});

// Approve a doc
router.put('/:projectId/docs/:docId/approve', async (req, res) => {
  try {
    const doc = await convexClient.query(api.foundationalDocs.getByExternalId, { externalId: req.params.docId });
    if (!doc || doc.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const newApproved = !doc.approved;
    await convexClient.mutation(api.foundationalDocs.update, {
      externalId: req.params.docId,
      approved: newApproved,
    });

    const updated = await convexClient.query(api.foundationalDocs.getByExternalId, { externalId: req.params.docId });
    res.json({
      id: updated.externalId,
      project_id: updated.project_id,
      doc_type: updated.doc_type,
      content: updated.content,
      version: updated.version,
      approved: updated.approved ? 1 : 0,
      source: updated.source,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
    });
  } catch (err) {
    res.status(404).json({ error: 'Document not found' });
  }
});

// Scan all docs for inaccurate claims and propose corrections
router.post('/:projectId/correct-docs', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { correction } = req.body;
  if (!correction || correction.trim().length === 0) {
    return res.status(400).json({ error: 'Correction instruction is required' });
  }

  console.log(`[CopyCorrection] Scanning docs for: "${correction.trim().slice(0, 80)}"`);
  const startTime = Date.now();
  try {
    const result = await findAndCorrectDocs(req.params.projectId, correction.trim());
    console.log(`[CopyCorrection] Done in ${((Date.now() - startTime) / 1000).toFixed(1)}s — ${result.corrections?.length || 0} corrections found`);
    for (const c of (result.corrections || [])) {
      console.log(`[CopyCorrection]   → ${c.doc_type}: doc_id=${c.doc_id}, old_text="${(c.old_text || '').slice(0, 40)}..."`);
    }
    res.json(result);
  } catch (err) {
    console.error(`[CopyCorrection] Error after ${((Date.now() - startTime) / 1000).toFixed(1)}s:`, err.message);
    res.status(500).json({ error: err.message || 'Failed to analyze documents' });
  }
});

// Apply proposed corrections to documents (with history tracking)
router.post('/:projectId/apply-corrections', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { corrections, correction_text } = req.body;
  if (!Array.isArray(corrections) || corrections.length === 0) {
    return res.status(400).json({ error: 'Corrections array is required' });
  }

  try {
    const result = await applyCorrections(req.params.projectId, corrections, correction_text);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[CopyCorrection] Apply error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get correction history for a project
router.get('/:projectId/correction-history', async (req, res) => {
  try {
    const history = await getHistory(req.params.projectId);
    res.json({ history });
  } catch {
    res.json({ history: [] });
  }
});

// Revert a correction (restore before-state of all docs in that correction)
router.post('/:projectId/revert-correction', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { correction_id } = req.body;
  if (!correction_id) return res.status(400).json({ error: 'correction_id is required' });

  try {
    const result = await revertCorrection(req.params.projectId, correction_id);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[CopyCorrection] Revert error:', err.message);
    const status = err.status || 500;
    res.status(status).json({ error: err.message || 'Failed to revert correction' });
  }
});

export default router;
