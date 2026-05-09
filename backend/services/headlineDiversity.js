const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'of', 'on',
  'or', 'our', 'so', 'that', 'the', 'their', 'them', 'there', 'these', 'they',
  'this', 'to', 'was', 'we', 'were', 'what', 'when', 'why', 'with', 'you', 'your',
]);

const GENERIC_SCENE_STOPWORDS = new Set([
  ...STOPWORDS,
  'after', 'again', 'already', 'around', 'back', 'body', 'can', 'deal', 'exact',
  'feels', 'gets', 'getting', 'gone', 'help', 'issue', 'kind', 'minute', 'minutes',
  'more', 'most', 'night', 'now', 'once', 'pattern', 'problem', 'real', 'really',
  'right', 'seconds', 'settle', 'specific', 'still', 'system', 'then', 'there',
  'trip', 'twice', 'using', 'very',
]);

const ANGLE_SIGNAL_STOPWORDS = new Set([
  ...STOPWORDS,
  'about', 'above', 'across', 'adult', 'adults', 'after', 'again', 'already',
  'around', 'because', 'before', 'being', 'brand', 'buyer', 'called', 'calling',
  'category', 'clarity', 'clear', 'come', 'comes', 'could', 'course', 'day',
  'different', 'does', 'doing', 'each', 'else', 'enough', 'every', 'everyone',
  'exactly', 'feel', 'feeling', 'feels', 'find', 'finding', 'first', 'free',
  'get', 'gets', 'getting', 'give', 'going', 'good', 'great', 'growth', 'help',
  'helps', 'here', 'into', 'just', 'keep', 'keeps', 'know', 'language', 'life',
  'like', 'live', 'make', 'makes', 'many', 'maybe', 'more', 'most', 'must',
  'need', 'needs', 'next', 'only', 'option', 'options', 'others', 'people',
  'person', 'product', 'program', 'really', 'right', 'same', 'see', 'service',
  'should', 'something', 'start', 'step', 'sure', 'thing', 'things', 'today',
  'trust', 'trusted', 'try', 'trying', 'use', 'want', 'wants', 'webinar',
  'without', 'work', 'working', 'world', 'would',
]);

const GENERIC_HEADLINE_PATTERNS = [
  /\bfree\s+(?:live\s+)?webinar\b/i,
  /\bget\s+clarity\s+(?:today|now)?\b/i,
  /\bfinding\s+your\s+calling\b/i,
  /\bfind\s+your\s+calling\b/i,
  /\bdiscover\s+your\s+calling\b/i,
  /\bstart\s+your\s+journey\b/i,
  /\btake\s+the\s+next\s+step\b/i,
  /\blearn\s+more\s+today\b/i,
];

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeHeadlineText(value) {
  return safeString(value)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFacet(value) {
  return normalizeHeadlineText(value);
}

function tokenize(value) {
  return normalizeHeadlineText(value).split(' ').filter(Boolean);
}

function significantTokens(value) {
  const tokens = tokenize(value).filter((token) => !STOPWORDS.has(token));
  return tokens.length > 0 ? tokens : tokenize(value);
}

function tokenSimilarity(a, b) {
  const left = new Set(significantTokens(a));
  const right = new Set(significantTokens(b));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / Math.max(left.size, right.size);
}

function sharesPrefix(a, b, count = 3) {
  const left = tokenize(a).slice(0, count);
  const right = tokenize(b).slice(0, count);
  if (left.length < count || right.length < count) return false;
  return left.every((token, index) => token === right[index]);
}

function numericScore(candidate) {
  if (typeof candidate?.average_score === 'number') return candidate.average_score;
  if (candidate?.scores && typeof candidate.scores === 'object') {
    const values = Object.values(candidate.scores)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (values.length > 0) {
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    }
  }
  if (typeof candidate?.rank === 'number') return Math.max(0, 100 - candidate.rank);
  return 0;
}

function toComparableHeadline(entry) {
  return {
    headline: safeString(entry?.headline || entry?.headline_text),
    hook_lane: safeString(entry?.hook_lane),
    sub_angle: safeString(entry?.sub_angle),
    scene_anchor: safeString(entry?.scene_anchor),
    core_claim: safeString(entry?.core_claim),
    target_symptom: safeString(entry?.target_symptom),
    emotional_entry: safeString(entry?.emotional_entry || entry?.primary_emotion),
    primary_emotion: safeString(entry?.primary_emotion || entry?.emotional_entry),
    desired_belief_shift: safeString(entry?.desired_belief_shift),
    opening_pattern: safeString(entry?.opening_pattern),
    word_count: Number(entry?.word_count) || null,
    scores: entry?.scores && typeof entry.scores === 'object' ? entry.scores : undefined,
    average_score: numericScore(entry),
    rank: typeof entry?.rank === 'number' ? entry.rank : null,
    angle_signal_score: Number.isFinite(entry?.angle_signal_score) ? entry.angle_signal_score : 0,
    angle_signal_visible_score: Number.isFinite(entry?.angle_signal_visible_score) ? entry.angle_signal_visible_score : 0,
    angle_signal_fields: Array.isArray(entry?.angle_signal_fields) ? entry.angle_signal_fields : undefined,
    angle_signal_tokens: Array.isArray(entry?.angle_signal_tokens) ? entry.angle_signal_tokens : undefined,
  };
}

function compareCandidates(left, right) {
  const signalDiff = (Number(right?.angle_signal_score) || 0) - (Number(left?.angle_signal_score) || 0);
  if (Math.abs(signalDiff) > 0.0001) return signalDiff;
  const visibleSignalDiff = (Number(right?.angle_signal_visible_score) || 0) - (Number(left?.angle_signal_visible_score) || 0);
  if (Math.abs(visibleSignalDiff) > 0.0001) return visibleSignalDiff;
  const scoreDiff = numericScore(right) - numericScore(left);
  if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
  const leftRank = typeof left?.rank === 'number' ? left.rank : Number.MAX_SAFE_INTEGER;
  const rightRank = typeof right?.rank === 'number' ? right.rank : Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) return leftRank - rightRank;
  return safeString(left?.headline).localeCompare(safeString(right?.headline));
}

function conflictResult(duplicate, reasons = [], similarity = 0) {
  return { duplicate, reasons, similarity };
}

function compactReasonCounts(rejected) {
  return rejected.reduce((counts, entry) => {
    for (const reason of entry.reasons || []) {
      counts[reason] = (counts[reason] || 0) + 1;
    }
    return counts;
  }, {});
}

function distinctiveTokens(value, maxTokens = 18) {
  const seen = new Set();
  const tokens = tokenize(value)
    .filter((token) => token.length >= 4)
    .filter((token) => !ANGLE_SIGNAL_STOPWORDS.has(token))
    .filter((token) => {
      if (seen.has(token)) return false;
      seen.add(token);
      return true;
    });
  return tokens.slice(0, maxTokens);
}

function buildSignalFacet(name, sourceText, weight = 1) {
  const tokens = distinctiveTokens(sourceText);
  if (tokens.length === 0) return null;
  return { name, tokens, weight };
}

function corpusForAngleSignal(candidate, { visibleOnly = false } = {}) {
  const visibleParts = [
    safeString(candidate?.headline || candidate?.headline_text),
    safeString(candidate?.body_copy),
    safeString(candidate?.primary_text),
  ];
  const metadataParts = [
    safeString(candidate?.target_symptom),
    safeString(candidate?.core_claim),
    safeString(candidate?.scene_anchor),
    safeString(candidate?.sub_angle),
    safeString(candidate?.emotional_entry || candidate?.primary_emotion),
    safeString(candidate?.desired_belief_shift),
  ];
  return normalizeHeadlineText((visibleOnly ? visibleParts : [...visibleParts, ...metadataParts]).filter(Boolean).join(' '));
}

function tokenSet(value) {
  return new Set(tokenize(value));
}

function matchFacet(corpusTokens, facet) {
  const matched = facet.tokens.filter((token) => corpusTokens.has(token));
  if (matched.length === 0) return null;
  return {
    field: facet.name,
    tokens: matched,
    score: matched.length * facet.weight,
  };
}

export function buildAngleSignalProfile(angleBrief) {
  if (!angleBrief || typeof angleBrief !== 'object') return null;
  const facets = [
    buildSignalFacet('scene', angleBrief.scene, 3),
    buildSignalFacet('symptom_pattern', angleBrief.symptom_pattern, 3),
    buildSignalFacet('core_buyer', angleBrief.core_buyer, 2),
    buildSignalFacet('current_belief', angleBrief.current_belief, 2),
    buildSignalFacet('objection', angleBrief.objection, 2),
    buildSignalFacet('failed_solutions', angleBrief.failed_solutions, 1),
    buildSignalFacet('frame', String(angleBrief.frame || '').replace(/-/g, ' '), 1),
  ].filter(Boolean);

  if (facets.length === 0) return null;
  return {
    angleName: safeString(angleBrief.name),
    frame: safeString(angleBrief.frame),
    facets,
    genericPatterns: GENERIC_HEADLINE_PATTERNS,
  };
}

export function evaluateAngleSignal(candidate, angleBrief, profile = null) {
  const signalProfile = profile || buildAngleSignalProfile(angleBrief);
  if (!signalProfile) {
    return {
      aligned: true,
      score: 0,
      visibleScore: 0,
      matchedFields: [],
      matchedTokens: [],
      reasons: [],
      genericHeadline: false,
    };
  }

  const comparable = toComparableHeadline(candidate);
  const headline = comparable.headline;
  const fullTokens = tokenSet(corpusForAngleSignal(candidate));
  const visibleTokens = tokenSet(corpusForAngleSignal(candidate, { visibleOnly: true }));
  const matches = signalProfile.facets
    .map((facet) => matchFacet(fullTokens, facet))
    .filter(Boolean);
  const visibleMatches = signalProfile.facets
    .map((facet) => matchFacet(visibleTokens, facet))
    .filter(Boolean);
  const score = matches.reduce((sum, match) => sum + match.score, 0);
  const visibleScore = visibleMatches.reduce((sum, match) => sum + match.score, 0);
  const genericHeadline = signalProfile.genericPatterns.some((pattern) => pattern.test(headline));
  const reasons = [];

  if (score <= 0) reasons.push('zero_angle_signal');
  if (genericHeadline && visibleScore <= 1) reasons.push('generic_offer_or_category_headline');

  return {
    aligned: reasons.length === 0,
    score,
    visibleScore,
    matchedFields: matches.map((match) => match.field),
    matchedTokens: Array.from(new Set(matches.flatMap((match) => match.tokens))),
    reasons,
    genericHeadline,
  };
}

export function filterAngleSignalHeadlines(candidates, angleBrief) {
  const profile = buildAngleSignalProfile(angleBrief);
  if (!profile) {
    return {
      active: false,
      profile: null,
      survivors: candidates.map(toComparableHeadline).filter((candidate) => candidate.headline),
      rejected: [],
      reasonCounts: {},
    };
  }

  const survivors = [];
  const rejected = [];
  for (const candidate of candidates.map(toComparableHeadline).filter((entry) => entry.headline)) {
    const result = evaluateAngleSignal(candidate, angleBrief, profile);
    if (result.aligned) {
      survivors.push({
        ...candidate,
        angle_signal_score: result.score,
        angle_signal_visible_score: result.visibleScore,
        angle_signal_fields: result.matchedFields,
        angle_signal_tokens: result.matchedTokens,
      });
    } else {
      rejected.push({
        candidate,
        reasons: result.reasons,
        score: result.score,
        visibleScore: result.visibleScore,
        matchedFields: result.matchedFields,
        matchedTokens: result.matchedTokens,
      });
    }
  }

  survivors.sort((left, right) => {
    const signalDiff = (right.angle_signal_score || 0) - (left.angle_signal_score || 0);
    if (Math.abs(signalDiff) > 0.0001) return signalDiff;
    const visibleDiff = (right.angle_signal_visible_score || 0) - (left.angle_signal_visible_score || 0);
    if (Math.abs(visibleDiff) > 0.0001) return visibleDiff;
    return compareCandidates(left, right);
  });

  return {
    active: true,
    profile,
    survivors,
    rejected,
    reasonCounts: compactReasonCounts(rejected),
  };
}

function buildLexicalConcept(key, sourceText, minSharedTokens = 2) {
  const tokens = significantTokens(sourceText)
    .filter((token) => !GENERIC_SCENE_STOPWORDS.has(token))
    .slice(0, 8);
  if (tokens.length === 0) return null;
  return {
    key,
    terms: tokens,
    matchMode: 'token_count',
    minMatches: Math.min(minSharedTokens, tokens.length),
    required: false,
  };
}

function createPhraseConcept(key, terms, { required = false, minMatches = 1 } = {}) {
  return { key, terms, required, minMatches, matchMode: 'any' };
}

function buildSceneConcepts(sourceText, angleBrief) {
  const concepts = [];
  if (/\b(pee|bathroom|toilet|restroom|urinat)/i.test(sourceText)) {
    concepts.push(createPhraseConcept('bathroom_trip', [
      'pee',
      'bathroom',
      'toilet',
      'restroom',
      'urinate',
      'urination',
      'bathroom trip',
      'bathroom wake',
      'wake to pee',
      'wakes to pee',
      'nighttime bathroom',
      'middle of the night bathroom',
    ], { required: true }));
  }

  if (/\b(wake|wakes|waking|night|overnight|2 am|3 am|middle of the night|nighttime)\b/i.test(sourceText)) {
    concepts.push(createPhraseConcept('night_wake', [
      'wake',
      'wakes',
      'waking',
      'awake',
      'night',
      'nighttime',
      'overnight',
      '2 am',
      '3 am',
      'middle of the night',
      '3am',
      '2am',
    ]));
  }

  if (/\b(back in bed|fall back asleep|sleep is gone|stays alert|awake for real|wide awake|back to sleep|cannot fall back asleep|cant fall back asleep|alert)\b/i.test(sourceText)) {
    concepts.push(createPhraseConcept('back_to_sleep_failure', [
      'back in bed',
      'fall back asleep',
      'cannot fall back asleep',
      'cant fall back asleep',
      'back to sleep',
      'sleep is gone',
      'sleep gone',
      'stays alert',
      'awake for real',
      'wide awake',
      'fully awake',
      'now awake',
      'awake now',
      'up for real',
      'ends your night',
      'night is over',
      'alert',
      'asleep again',
    ], { required: true }));
  }

  const lexicalFallback = buildLexicalConcept(
    'scene_keywords',
    `${angleBrief?.scene || ''} ${angleBrief?.symptom_pattern || ''}`,
    2
  );
  if (lexicalFallback) concepts.push(lexicalFallback);

  return concepts;
}

export function buildSceneLockProfile(angleBrief) {
  const scene = safeString(angleBrief?.scene);
  const symptomPattern = safeString(angleBrief?.symptom_pattern);
  if (!scene || !symptomPattern) return null;

  const sourceText = `${scene} ${symptomPattern}`;
  const concepts = buildSceneConcepts(sourceText, angleBrief);
  const requiredConcepts = concepts.filter((concept) => concept.required).map((concept) => concept.key);
  if (requiredConcepts.length === 0) return null;

  const minConceptMatches = Math.min(
    concepts.length,
    Math.max(2, requiredConcepts.length)
  );

  return {
    locked: true,
    scene,
    symptomPattern,
    sourceText,
    concepts,
    requiredConcepts,
    minConceptMatches,
  };
}

function corpusForSceneAlignment(candidate) {
  return normalizeHeadlineText([
    safeString(candidate?.headline || candidate?.headline_text),
    safeString(candidate?.target_symptom),
    safeString(candidate?.core_claim),
    safeString(candidate?.scene_anchor),
    safeString(candidate?.sub_angle),
  ].filter(Boolean).join(' '));
}

function countTokenMatches(corpus, terms) {
  const corpusTokens = new Set(significantTokens(corpus));
  let matches = 0;
  for (const term of terms) {
    if (corpusTokens.has(term)) matches += 1;
  }
  return matches;
}

function conceptMatchesCorpus(corpus, concept) {
  if (!corpus || !concept) return false;
  if (concept.matchMode === 'token_count') {
    return countTokenMatches(corpus, concept.terms) >= (concept.minMatches || 1);
  }
  return concept.terms.some((term) => corpus.includes(normalizeHeadlineText(term)));
}

export function evaluateSceneAlignment(candidate, angleBrief, profile = null) {
  const sceneProfile = profile || buildSceneLockProfile(angleBrief);
  if (!sceneProfile?.locked) {
    return { aligned: true, reasons: [], matchedConcepts: [], similarity: 0 };
  }

  const comparable = toComparableHeadline(candidate);
  const corpus = corpusForSceneAlignment(comparable);
  const matchedConcepts = sceneProfile.concepts
    .filter((concept) => conceptMatchesCorpus(corpus, concept))
    .map((concept) => concept.key);
  const reasons = [];
  const similarity = tokenSimilarity(corpus, sceneProfile.sourceText);

  for (const conceptKey of sceneProfile.requiredConcepts) {
    if (!matchedConcepts.includes(conceptKey)) reasons.push(`missing_${conceptKey}`);
  }

  if (matchedConcepts.length < sceneProfile.minConceptMatches) {
    reasons.push('insufficient_scene_specificity');
  }

  if (similarity < 0.12) {
    reasons.push('low_scene_overlap');
  }

  if (
    comparable.hook_lane === 'consequence_led' &&
    !matchedConcepts.includes('back_to_sleep_failure')
  ) {
    reasons.push('consequence_without_return_to_sleep');
  }

  return {
    aligned: reasons.length === 0,
    reasons,
    matchedConcepts,
    similarity,
  };
}

export function filterSceneAlignedHeadlines(candidates, angleBrief) {
  const sceneProfile = buildSceneLockProfile(angleBrief);
  if (!sceneProfile?.locked) {
    return {
      sceneLocked: false,
      profile: null,
      survivors: candidates.map(toComparableHeadline).filter((candidate) => candidate.headline),
      rejected: [],
      reasonCounts: {},
    };
  }

  const survivors = [];
  const rejected = [];

  for (const candidate of candidates.map(toComparableHeadline).filter((entry) => entry.headline)) {
    const result = evaluateSceneAlignment(candidate, angleBrief, sceneProfile);
    if (result.aligned) {
      survivors.push(candidate);
    } else {
      rejected.push({
        candidate,
        reasons: result.reasons,
        matchedConcepts: result.matchedConcepts,
        similarity: result.similarity,
      });
    }
  }

  return {
    sceneLocked: true,
    profile: sceneProfile,
    survivors,
    rejected,
    reasonCounts: compactReasonCounts(rejected),
  };
}

export function evaluateHeadlineConflict(candidate, other) {
  const current = toComparableHeadline(candidate);
  const existing = toComparableHeadline(other);
  if (!current.headline || !existing.headline) return conflictResult(false);

  const currentNormalized = normalizeHeadlineText(current.headline);
  const existingNormalized = normalizeHeadlineText(existing.headline);
  const currentLane = normalizeFacet(current.hook_lane);
  const existingLane = normalizeFacet(existing.hook_lane);
  const currentClaim = normalizeFacet(current.core_claim);
  const existingClaim = normalizeFacet(existing.core_claim);
  const currentSymptom = normalizeFacet(current.target_symptom);
  const existingSymptom = normalizeFacet(existing.target_symptom);
  const currentBelief = normalizeFacet(current.desired_belief_shift);
  const existingBelief = normalizeFacet(existing.desired_belief_shift);
  const currentOpening = normalizeFacet(current.opening_pattern);
  const existingOpening = normalizeFacet(existing.opening_pattern);
  const currentEmotion = normalizeFacet(current.emotional_entry);
  const existingEmotion = normalizeFacet(existing.emotional_entry);
  if (currentNormalized === existingNormalized) {
    return conflictResult(true, ['exact_text'], 1);
  }

  const sameLane = !!currentLane && currentLane === existingLane;
  const sameClaim = !!currentClaim && currentClaim === existingClaim;
  const sameSymptom = !!currentSymptom && currentSymptom === existingSymptom;
  const sameBelief = !!currentBelief && currentBelief === existingBelief;
  const sameOpening = !!currentOpening && currentOpening === existingOpening;
  const sameEmotion = !!currentEmotion && currentEmotion === existingEmotion;
  const similarity = tokenSimilarity(current.headline, existing.headline);
  const prefixMatch = sharesPrefix(current.headline, existing.headline);
  const reasons = [];

  if (similarity >= 0.88) reasons.push('very_high_text_similarity');
  else if (similarity >= 0.72) reasons.push('high_text_similarity');
  if (sameLane) reasons.push('same_hook_lane');
  if (sameClaim) reasons.push('same_core_claim');
  if (sameSymptom) reasons.push('same_target_symptom');
  if (sameBelief) reasons.push('same_belief_shift');
  if (sameOpening) reasons.push('same_opening_pattern');
  if (sameEmotion) reasons.push('same_emotional_entry');
  if (prefixMatch) reasons.push('same_opening_words');

  if (sameLane && sameClaim) return conflictResult(true, reasons, similarity);
  if (sameClaim && sameOpening) return conflictResult(true, reasons, similarity);
  if (similarity >= 0.88) return conflictResult(true, reasons, similarity);
  if (sameLane && sameSymptom && sameBelief && similarity >= 0.45) return conflictResult(true, reasons, similarity);
  if (sameLane && prefixMatch && similarity >= 0.45) return conflictResult(true, reasons, similarity);
  if (sameClaim && similarity >= 0.45) return conflictResult(true, reasons, similarity);

  return conflictResult(false, reasons, similarity);
}

export function filterHeadlineCandidatePool(candidates, history = []) {
  const sortedCandidates = [...candidates]
    .map(toComparableHeadline)
    .filter((candidate) => candidate.headline)
    .sort(compareCandidates);

  const survivors = [];
  const rejectedInBatch = [];
  const rejectedByHistory = [];

  for (const candidate of sortedCandidates) {
    const historyConflict = history.find((entry) => evaluateHeadlineConflict(candidate, entry).duplicate);
    if (historyConflict) {
      rejectedByHistory.push({ candidate, against: toComparableHeadline(historyConflict) });
      continue;
    }

    const intraBatchConflict = survivors.find((existing) => evaluateHeadlineConflict(candidate, existing).duplicate);
    if (intraBatchConflict) {
      rejectedInBatch.push({ candidate, against: intraBatchConflict });
      continue;
    }

    survivors.push(candidate);
  }

  return { survivors, rejectedInBatch, rejectedByHistory };
}

export function selectDiverseHeadlines(candidates, targetCount, existingSelected = []) {
  const selected = [...existingSelected].map(toComparableHeadline);
  const selectedNormalized = new Set(selected.map((candidate) => normalizeHeadlineText(candidate.headline)));
  const laneCounts = new Map();
  const claimCounts = new Map();

  for (const candidate of selected) {
    const laneKey = normalizeFacet(candidate.hook_lane);
    const claimKey = normalizeFacet(candidate.core_claim);
    if (laneKey) laneCounts.set(laneKey, (laneCounts.get(laneKey) || 0) + 1);
    if (claimKey) claimCounts.set(claimKey, (claimCounts.get(claimKey) || 0) + 1);
  }

  const available = [...candidates]
    .map(toComparableHeadline)
    .filter((candidate) => candidate.headline && !selectedNormalized.has(normalizeHeadlineText(candidate.headline)))
    .sort(compareCandidates);

  const overflow = [];
  const distinctLanes = new Set(available.map((candidate) => normalizeFacet(candidate.hook_lane)).filter(Boolean));
  const laneCap = Math.max(2, Math.ceil(targetCount / Math.max(1, distinctLanes.size || 1)));

  const addCandidate = (candidate) => {
    selected.push(candidate);
    selectedNormalized.add(normalizeHeadlineText(candidate.headline));
    const laneKey = normalizeFacet(candidate.hook_lane);
    const claimKey = normalizeFacet(candidate.core_claim);
    if (laneKey) laneCounts.set(laneKey, (laneCounts.get(laneKey) || 0) + 1);
    if (claimKey) claimCounts.set(claimKey, (claimCounts.get(claimKey) || 0) + 1);
  };

  // First pass: seed lane spread.
  const bestByLane = new Map();
  for (const candidate of available) {
    const laneKey = normalizeFacet(candidate.hook_lane);
    if (!laneKey || bestByLane.has(laneKey)) continue;
    if ((laneCounts.get(laneKey) || 0) > 0) continue;
    if (selected.some((existing) => evaluateHeadlineConflict(candidate, existing).duplicate)) continue;
    bestByLane.set(laneKey, candidate);
  }
  for (const candidate of bestByLane.values()) {
    if (selected.length >= targetCount) break;
    addCandidate(candidate);
  }

  for (const candidate of available) {
    if (selected.length >= targetCount) break;
    if (selectedNormalized.has(normalizeHeadlineText(candidate.headline))) continue;
    if (selected.some((existing) => evaluateHeadlineConflict(candidate, existing).duplicate)) continue;

    const laneKey = normalizeFacet(candidate.hook_lane);
    const claimKey = normalizeFacet(candidate.core_claim);
    if (laneKey && (laneCounts.get(laneKey) || 0) >= laneCap) {
      overflow.push(candidate);
      continue;
    }
    if (claimKey && (claimCounts.get(claimKey) || 0) >= 1) {
      overflow.push(candidate);
      continue;
    }
    addCandidate(candidate);
  }

  for (const candidate of available) {
    if (selected.length >= targetCount) break;
    if (selectedNormalized.has(normalizeHeadlineText(candidate.headline))) continue;
    if (selected.some((existing) => evaluateHeadlineConflict(candidate, existing).duplicate)) continue;
    addCandidate(candidate);
  }

  const laneDistribution = {};
  for (const candidate of selected) {
    const lane = candidate.hook_lane || 'unassigned';
    laneDistribution[lane] = (laneDistribution[lane] || 0) + 1;
  }

  return { selected, overflow, laneDistribution };
}

export function buildHeadlineHistoryEntry({
  projectId,
  angleName,
  batchJobId,
  conductorRunId,
  adCreativeId,
  candidate,
  createdAt,
}) {
  const headline = toComparableHeadline(candidate);
  return {
    externalId: adCreativeId,
    project_id: projectId,
    angle_name: angleName,
    batch_job_id: batchJobId || undefined,
    conductor_run_id: conductorRunId || undefined,
    ad_creative_id: adCreativeId || undefined,
    headline_text: headline.headline,
    normalized_headline: normalizeHeadlineText(headline.headline),
    hook_lane: headline.hook_lane || undefined,
    sub_angle: headline.sub_angle || undefined,
    core_claim: headline.core_claim || undefined,
    target_symptom: headline.target_symptom || undefined,
    emotional_entry: headline.emotional_entry || undefined,
    desired_belief_shift: headline.desired_belief_shift || undefined,
    opening_pattern: headline.opening_pattern || undefined,
    created_at: createdAt,
  };
}
