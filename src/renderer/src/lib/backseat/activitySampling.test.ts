import { describe, expect, it } from 'vitest';
import { classifyActivity, nextActivityIdleDelayMs, sampleIntervalMsForPolicy, selectSamplingPolicy } from './activitySampling';
import { GRID_OFFSETS_S, nextIdleDelayMs } from '../../../../shared/backseatIpc';

describe('activity sampling', () => {
  it('recognizes an explicit long video title', () => {
    expect(classifyActivity('Full documentary (2024) - YouTube').activity).toBe('long_video');
    expect(classifyActivity('Dune (2021) - Plex').activity).toBe('long_video');
  });
  it('falls back for generic services, shorts and missing metadata', () => {
    for (const title of ['YouTube', 'Funny Shorts - YouTube', 'Trailer (2024) - Plex', null]) {
      expect(selectSamplingPolicy(true, classifyActivity(title))).toBe('baseline');
    }
    expect(classifyActivity('Full movie (2024) - YouTube', 'screen').reason).toBe('unreliable_screen_label');
  });
  it('keeps the fixed baseline when disabled and stretches only selected idle delays', () => {
    const decision = classifyActivity('Full episode - Netflix');
    expect(selectSamplingPolicy(false, decision)).toBe('baseline');
    expect(nextActivityIdleDelayMs('baseline', () => 0.5)).toBe(nextIdleDelayMs(() => 0.5));
    expect(nextActivityIdleDelayMs('long_video', () => 0.5)).toBeGreaterThan(nextIdleDelayMs(() => 0.5));
    expect(nextActivityIdleDelayMs('long_video', () => 1)).toBeLessThanOrEqual(75_000);
    expect(sampleIntervalMsForPolicy('baseline')).toBe(100);
    expect(sampleIntervalMsForPolicy('long_video')).toBeLessThan((GRID_OFFSETS_S[4] - GRID_OFFSETS_S[5]) * 1000);
  });
});
