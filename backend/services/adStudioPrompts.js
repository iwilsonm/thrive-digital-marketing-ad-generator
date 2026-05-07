import { getProjectAudienceContext } from './adGenerator.js';

function trimSnippet(value, maxLength) {
  return String(value || '').slice(0, maxLength);
}

export function buildAngleGenerationPrompt({ project, avatarSnippet = '', offerSnippet = '' }) {
  const audienceContext = getProjectAudienceContext(project, {
    avatar: { content: avatarSnippet },
    offer_brief: { content: offerSnippet },
  });

  return `You are a direct response ad strategist. Based on the brand and audience docs below, suggest ONE specific, unexpected ad angle/topic.

PROJECT AUDIENCE CONTEXT:
${audienceContext}

BRAND: ${project.brand_name || project.name}
PRODUCT: ${project.product_description || ''}

AVATAR (excerpt):
${trimSnippet(avatarSnippet, 2000)}

OFFER BRIEF (excerpt):
${trimSnippet(offerSnippet, 2000)}

Return ONLY a short angle phrase (3-10 words). No explanation, no quotes, no numbering. Just the angle.
Examples of good angles should be specific to the docs above: a concrete moment, objection, belief shift, or question the documented audience would immediately recognize.`;
}

export function buildHeadlineGenerationPrompt({ project, angle = '', avatarSnippet = '', offerSnippet = '', researchSnippet = '' }) {
  const audienceContext = getProjectAudienceContext(project, {
    avatar: { content: avatarSnippet },
    offer_brief: { content: offerSnippet },
    research: { content: researchSnippet },
  });

  return `You are a world-class direct response copywriter who writes scroll-stopping Facebook ad headlines for this specific project. Use the project materials below to understand the audience, offer, emotional context, and specificity.

PROJECT AUDIENCE CONTEXT:
${audienceContext}

BRAND: ${project.brand_name || project.name}
PRODUCT: ${project.product_description || ''}
${angle ? `AD ANGLE: "${angle}"` : ''}

AVATAR (excerpt):
${trimSnippet(avatarSnippet, 2000)}

OFFER BRIEF (excerpt):
${trimSnippet(offerSnippet, 1500)}

${researchSnippet ? `RESEARCH (excerpt):\n${trimSnippet(researchSnippet, 1500)}` : ''}

Write ONE scroll-stopping headline that:
- Sounds like something a real person would say, not marketing copy
- Is specific and emotional
- Speaks directly to the target audience described above
- ${angle ? `Focuses on the angle: "${angle}"` : 'Picks a compelling angle from the docs'}

Return ONLY the headline text. No quotes, no labels, no explanation. Under 15 words.`;
}
