import { IDLE_MAX_MS, SAMPLE_INTERVAL_MS, nextIdleDelayMs } from '../../../../shared/backseatIpc';

export type ActivityDecision = {
  activity: 'long_video' | 'unknown';
  confidence: number;
  reason: 'title_match' | 'missing_title' | 'insufficient_metadata' | 'unreliable_screen_label';
};

/** Titles are only a coarse activity hint. They never determine an event. */
export function classifyActivity(label: string | null, sourceKind: 'window' | 'screen' = 'window'): ActivityDecision {
  // Whole-screen frontmost titles come from an ordering heuristic; do not let
  // that uncertain attribution change capture policy.
  if (sourceKind === 'screen') return { activity: 'unknown', confidence: 0, reason: 'unreliable_screen_label' };
  if (!label) return { activity: 'unknown', confidence: 0, reason: 'missing_title' };
  const title = label.toLowerCase();
  // Require a long-form cue as well as a video service. A service name alone
  // also describes its home page, search results and short clips.
  const service = /(?:youtube|plex|netflix|prime video|disney\+|vimeo)/i.test(title);
  const longForm = /(?:full (?:movie|film|episode|documentary)|(?:movie|film|episode|documentary)\b|\b\d{1,2}:\d{2}:\d{2}\b|\b\d{1,3}\s*(?:min(?:ute)?s?|hours?|hrs?)\b|\(\d{4}\))/i.test(title);
  if (service && longForm && !/(?:shorts|reels|trailer|teaser|clip\b)/i.test(title)) {
    return { activity: 'long_video', confidence: 0.8, reason: 'title_match' };
  }
  return { activity: 'unknown', confidence: 0.2, reason: 'insufficient_metadata' };
}

export type SamplingPolicy = 'baseline' | 'long_video';

/** 125 ms still resolves the grid's tightest 187.5 ms pair. */
export function sampleIntervalMsForPolicy(policy: SamplingPolicy): number {
  return policy === 'long_video' ? 125 : SAMPLE_INTERVAL_MS;
}

export function selectSamplingPolicy(enabled: boolean, decision: ActivityDecision): SamplingPolicy {
  return enabled && decision.activity === 'long_video' && decision.confidence >= 0.8
    ? 'long_video' : 'baseline';
}

/** Retain the shifted exponential baseline; only stretch idle looks modestly. */
export function nextActivityIdleDelayMs(policy: SamplingPolicy, rand: () => number = Math.random): number {
  const baseline = nextIdleDelayMs(rand);
  return policy === 'long_video' ? Math.min(Math.round(baseline * 1.25), IDLE_MAX_MS + 15_000) : baseline;
}
