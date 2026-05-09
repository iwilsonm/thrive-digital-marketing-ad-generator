import { describe, expect, it } from 'vitest';

import {
  evaluateAngleSignal,
  filterAngleSignalHeadlines,
  buildSceneLockProfile,
  filterSceneAlignedHeadlines,
} from '../services/headlineDiversity.js';

const angleBrief = {
  frame: 'symptom-first',
  symptom_pattern: 'Wakes once or twice a night to use the bathroom, gets back in bed, then her body stays alert and sleep is gone.',
  scene: 'She gets back into bed after using the bathroom and can tell within 30 seconds that she is now awake for real.',
};

describe('headline scene alignment', () => {
  it('locks the wake-to-pee angle to its required concepts', () => {
    const profile = buildSceneLockProfile(angleBrief);
    expect(profile?.locked).toBe(true);
    expect(profile?.requiredConcepts).toContain('bathroom_trip');
    expect(profile?.requiredConcepts).toContain('back_to_sleep_failure');
  });

  it('keeps headlines anchored to the exact bathroom-trip scene', () => {
    const result = filterSceneAlignedHeadlines([
      {
        headline: 'Why your 3 AM bathroom trip can leave you wide awake',
        hook_lane: 'mechanism_curiosity',
        target_symptom: 'wake to pee and cannot fall back asleep',
        core_claim: 'bathroom wake-ups can keep your body alert',
        scene_anchor: 'back in bed after a bathroom trip and suddenly awake',
      },
      {
        headline: 'Drives slower now. Does not trust her reaction time.',
        hook_lane: 'consequence_led',
        target_symptom: 'next-day fatigue',
        core_claim: 'broken sleep hurts daytime confidence',
      },
      {
        headline: 'Prescription worked three nights. Then her body outsmarted it.',
        hook_lane: 'failed_solutions',
        target_symptom: 'sleep frustration',
        core_claim: 'sleep aids stop working',
      },
    ], angleBrief);

    expect(result.sceneLocked).toBe(true);
    expect(result.survivors).toHaveLength(1);
    expect(result.survivors[0].headline).toContain('bathroom trip');
    expect(result.rejected).toHaveLength(2);
    expect(result.reasonCounts.missing_bathroom_trip).toBeGreaterThan(0);
  });

  it('allows metadata to keep a headline on-scene even when the wording is shorter', () => {
    const result = filterSceneAlignedHeadlines([
      {
        headline: 'Back in bed. Wide awake again.',
        hook_lane: 'oddly_specific_moment',
        target_symptom: 'wake to pee and cannot fall back asleep',
        core_claim: 'the bathroom trip is not the end of the problem',
        scene_anchor: 'back in bed after the bathroom and awake for real',
      },
    ], angleBrief);

    expect(result.survivors).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it('does not hard-lock Path-B style scene fields without explicit required concepts', () => {
    const pathBAngle = {
      frame: 'objection-first',
      core_buyer: 'A Christian adult comparing counseling paths before committing to training.',
      symptom_pattern: 'They keep comparing licensure, ministry, and certificate options but do not want to be pushed into one program.',
      objection: 'They worry a free webinar will become another enrollment pitch.',
      scene: 'A person sitting at a kitchen table with a Bible nearby, a notepad of half-formed questions, and a laptop open to a counseling program page.',
    };

    const profile = buildSceneLockProfile(pathBAngle);
    expect(profile).toBeNull();

    const result = filterSceneAlignedHeadlines([
      {
        headline: "Worried you'll be pushed to a program? Map options first.",
        hook_lane: 'objection_reversal',
        core_claim: 'map options before pressure',
        target_symptom: 'fear of being pushed into one program',
      },
    ], pathBAngle);

    expect(result.sceneLocked).toBe(false);
    expect(result.survivors).toHaveLength(1);
    expect(result.survivors[0].headline).toBe("Worried you'll be pushed to a program? Map options first.");
    expect(result.rejected).toHaveLength(0);
  });
});

describe('headline angle-signal filtering', () => {
  const counselingAngle = {
    name: 'Called, But Not Ready To Enroll',
    frame: 'objection-first',
    core_buyer: 'A Christian adult who is curious about becoming a Christian counsellor but feels too unsure to apply for a program.',
    symptom_pattern: 'They keep opening tabs for counselling courses, licensure pages, and ministry certificates, then closing them without deciding.',
    current_belief: 'They believe they need to be more certain before they can even attend an information session.',
    objection: 'They will ignore the ad if it sounds like another admissions pitch.',
    scene: 'They are at the kitchen table after the house is quiet, flipping between three open laptop tabs with different counselling paths.',
    avoid_list: 'No countdown hype. No limited seats pressure. No polished campus-style visuals.',
  };

  it('rejects generic webinar/category headlines and keeps angle-specific ones', () => {
    const result = filterAngleSignalHeadlines([
      { headline: 'Free Live Webinar', average_score: 10, hook_lane: 'identity_trust' },
      { headline: 'FINDING YOUR CALLING', average_score: 9, hook_lane: 'identity_trust' },
      { headline: 'Get Clarity Today', average_score: 8, hook_lane: 'objection_reversal' },
      {
        headline: 'No enrollment push—just sort the tabs you keep reopening.',
        average_score: 7,
        hook_lane: 'objection_reversal',
      },
      {
        headline: 'Licensure, ministry, certificate... which tab closes first?',
        average_score: 6,
        hook_lane: 'comparison',
      },
    ], counselingAngle);

    expect(result.active).toBe(true);
    expect(result.survivors.map((entry) => entry.headline)).toEqual([
      'No enrollment push—just sort the tabs you keep reopening.',
      'Licensure, ministry, certificate... which tab closes first?',
    ]);
    expect(result.rejected.map((entry) => entry.candidate.headline)).toEqual([
      'Free Live Webinar',
      'FINDING YOUR CALLING',
      'Get Clarity Today',
    ]);
    expect(result.reasonCounts.generic_offer_or_category_headline).toBeGreaterThan(0);
  });

  it('returns no survivors with a clear zero-angle-signal reason for all-generic candidates', () => {
    const result = filterAngleSignalHeadlines([
      { headline: 'Free Webinar', average_score: 10 },
      { headline: 'Start Your Journey', average_score: 9 },
      { headline: 'Learn More Today', average_score: 8 },
    ], counselingAngle);

    expect(result.survivors).toHaveLength(0);
    expect(result.rejected).toHaveLength(3);
    expect(result.reasonCounts.zero_angle_signal).toBe(3);
  });

  it('treats metadata-only specificity as insufficient when the visible headline is generic', () => {
    const candidate = {
      headline: 'Free Live Webinar',
      scene_anchor: 'three laptop tabs with counselling paths',
      target_symptom: 'uncertain about licensure vs ministry',
    };

    const result = evaluateAngleSignal(candidate, counselingAngle);

    expect(result.aligned).toBe(false);
    expect(result.reasons).toContain('generic_offer_or_category_headline');
    expect(result.score).toBeGreaterThan(0);
  });
});
