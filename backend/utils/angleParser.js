/**
 * angleParser.js — Parse structured angle briefs from markdown and build descriptions
 *
 * Handles parsing of gpt5.4_angles.md format and backward-compat description generation.
 */

const SECTION_MAP = {
  'core buyer': 'core_buyer',
  'symptom pattern': 'symptom_pattern',
  'failed solutions': 'failed_solutions',
  'current belief': 'current_belief',
  'objection': 'objection',
  'emotional state': 'emotional_state',
  'scene to center the ad on': 'scene',
  'desired belief shift': 'desired_belief_shift',
  'tone': 'tone',
  'avoid': 'avoid_list',
};

const VALID_PRIORITIES = ['highest', 'high', 'medium', 'test'];
const VALID_FRAMES = ['symptom-first', 'scam', 'objection-first', 'identity-first', 'MAHA', 'news-first', 'consequence-first'];

export function stripOuterMarkdownFence(markdown) {
  const text = String(markdown || '').trim();
  const match = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() : String(markdown || '');
}

// Reverse map: description label → database field key
const DESCRIPTION_LABEL_MAP = {
  'core buyer': 'core_buyer',
  'symptom pattern': 'symptom_pattern',
  'failed solutions': 'failed_solutions',
  'current belief': 'current_belief',
  'objection': 'objection',
  'emotional state': 'emotional_state',
  'scene to center the ad on': 'scene',
  'scene': 'scene',
  'desired belief shift': 'desired_belief_shift',
  'tone': 'tone',
  'avoid': 'avoid_list',
};

/**
 * Parse structured brief fields from a plain-text description.
 * Extracts "Label: value" patterns from description text.
 * Returns only fields that were found — empty fields omitted.
 */
export function parseBriefFromDescription(description) {
  if (!description || typeof description !== 'string') return {};
  const result = {};
  const lines = description.split('\n');
  const labels = Object.keys(DESCRIPTION_LABEL_MAP);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Check if line starts with a known label
    for (const label of labels) {
      const regex = new RegExp(`^${label}\\s*:\\s*(.+)`, 'i');
      const match = line.match(regex);
      if (match) {
        const fieldKey = DESCRIPTION_LABEL_MAP[label];
        let value = match[1].trim();
        // Collect continuation lines (lines that don't start with a known label)
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j].trim();
          if (!nextLine) break;
          const isLabel = labels.some(l => new RegExp(`^${l}\\s*:`, 'i').test(nextLine));
          if (isLabel) break;
          value += ' ' + nextLine;
        }
        if (value) result[fieldKey] = value;
        break;
      }
    }
  }
  return result;
}

/**
 * Build a flat description string from structured brief fields.
 * Used for backward compatibility — downstream code that reads angle.description
 * still gets a useful string.
 */
export function buildDescriptionFromBrief(fields) {
  const parts = [];
  if (fields.core_buyer) parts.push(`Core Buyer: ${fields.core_buyer}`);
  if (fields.symptom_pattern) parts.push(`Symptom Pattern: ${fields.symptom_pattern}`);
  if (fields.objection) parts.push(`Objection: ${fields.objection}`);
  if (fields.scene) parts.push(`Scene: ${fields.scene}`);
  if (fields.desired_belief_shift) parts.push(`Desired Belief Shift: ${fields.desired_belief_shift}`);
  return parts.length > 0 ? parts.join('\n') : 'No structured brief provided.';
}

/**
 * Build the full structured prompt from an angle's fields.
 * This replaces the old approach of using description + prompt_hints as a blob.
 */
export function buildStructuredAnglePrompt(angle) {
  const parts = [];

  if (angle.frame) parts.push(`Frame: ${angle.frame}`);
  if (angle.core_buyer) parts.push(`Core Buyer: ${angle.core_buyer}`);
  if (angle.symptom_pattern) parts.push(`Symptom Pattern: ${angle.symptom_pattern}`);
  if (angle.failed_solutions) parts.push(`Failed Solutions: ${angle.failed_solutions}`);
  if (angle.current_belief) parts.push(`Current Belief: ${angle.current_belief}`);
  if (angle.objection) parts.push(`Objection: ${angle.objection}`);
  if (angle.emotional_state) parts.push(`Emotional State: ${angle.emotional_state}`);
  if (angle.scene) parts.push(`Scene: ${angle.scene}`);
  if (angle.desired_belief_shift) parts.push(`Desired Belief Shift: ${angle.desired_belief_shift}`);
  if (angle.tone) parts.push(`Tone: ${angle.tone}`);
  if (angle.avoid_list) parts.push(`Avoid: ${angle.avoid_list}`);

  return parts.join('\n');
}

/**
 * Check if an angle has structured brief fields populated (vs legacy name+description only).
 */
export function hasStructuredBrief(angle) {
  return !!(angle.core_buyer || angle.symptom_pattern || angle.scene || angle.objection);
}

/**
 * Build a JSON-serializable angle brief object for storing on batch_jobs.angle_brief.
 */
export function buildAngleBriefJSON(angle) {
  return {
    name: angle.name,
    priority: angle.priority || null,
    frame: angle.frame || null,
    core_buyer: angle.core_buyer || null,
    symptom_pattern: angle.symptom_pattern || null,
    failed_solutions: angle.failed_solutions || null,
    current_belief: angle.current_belief || null,
    objection: angle.objection || null,
    emotional_state: angle.emotional_state || null,
    scene: angle.scene || null,
    desired_belief_shift: angle.desired_belief_shift || null,
    tone: angle.tone || null,
    avoid_list: angle.avoid_list || null,
  };
}

/**
 * Parse a markdown file in gpt5.4_angles.md format into an array of structured angle objects.
 *
 * @param {string} markdown - Raw markdown content
 * @returns {Array<object>} Array of parsed angle objects ready for DB insertion
 */
export function parseAnglesMarkdown(markdown) {
  markdown = stripOuterMarkdownFence(markdown);
  const angles = [];

  // Split by --- separators (horizontal rules)
  const blocks = markdown.split(/\n---\n/).map(b => b.trim()).filter(Boolean);

  for (const block of blocks) {
    // Must start with ## to be an angle block
    const titleMatch = block.match(/^##\s+(.+)/m);
    if (!titleMatch) continue;

    const name = titleMatch[1].trim();

    // Skip the "De-prioritized or Removed" section and "Notes for System Use"
    if (name.startsWith('Removed from') || name === 'De-prioritized or Removed' ||
        name.startsWith('Notes for System') || name.startsWith('Best categories') ||
        name.startsWith('What should') || name.startsWith('Strong output') ||
        name.startsWith('Weak output')) continue;

    const angle = { name, source: 'imported' };

    // Extract metadata bullets: - **Status**: value
    const statusMatch = block.match(/\*\*Status\*\*:\s*(.+)/i);
    if (statusMatch) angle.status = statusMatch[1].trim().toLowerCase();

    const priorityMatch = block.match(/\*\*Priority\*\*:\s*(.+)/i);
    if (priorityMatch) {
      const p = priorityMatch[1].trim().toLowerCase();
      angle.priority = VALID_PRIORITIES.includes(p) ? p : 'medium';
    }

    const frameMatch = block.match(/\*\*Frame\*\*:\s*(.+)/i);
    if (frameMatch) {
      const f = frameMatch[1].trim().toLowerCase();
      // Normalize frame values
      angle.frame = VALID_FRAMES.find(vf => vf.toLowerCase() === f) || f;
    }

    // Extract ### sections
    const sectionRegex = /###\s+(.+)\n([\s\S]*?)(?=###|\n---|\n##|$)/g;
    let match;
    while ((match = sectionRegex.exec(block)) !== null) {
      const sectionTitle = match[1].trim().toLowerCase();
      const sectionContent = match[2].trim();

      const fieldKey = SECTION_MAP[sectionTitle];
      if (fieldKey && sectionContent) {
        angle[fieldKey] = sectionContent;
      }
    }

    // Auto-compute description from structured fields
    angle.description = buildDescriptionFromBrief(angle);

    // Only include angles that have at least a name and some content
    if (angle.name && (angle.core_buyer || angle.symptom_pattern || angle.description !== 'No structured brief provided.')) {
      angles.push(angle);
    }
  }

  return angles;
}
