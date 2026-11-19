/** The gesture builder chains like react-native-gesture-handler's (regression: the 2nd call lost the proxy). */
import { describe, expect, it } from 'vitest';
import { Gesture } from '../src/host/gestureHandler';

describe('Gesture builder', () => {
  it('chains config and callbacks in any order', () => {
    const start = () => {};
    const g = Gesture.Pinch().runOnJS(true).onStart(start).onUpdate(() => {}).minPointers(2).onFinalize(() => {}) as unknown as {
      cbs: Record<string, unknown>;
      cfg: Record<string, unknown>;
    };
    expect(g.cbs.onStart).toBe(start);
    expect(typeof g.cbs.onFinalize).toBe('function');
    expect(g.cfg.minPointers).toBe(2);
    expect(g.cfg.runOnJS).toBe(true);
  });

  it('does not look like a promise or a string to React', () => {
    const g = Gesture.Pan() as unknown as Record<string | symbol, unknown>;
    expect(g.then).toBeUndefined();
    expect(g.toJSON).toBeUndefined();
    expect(() => String(g)).not.toThrow();
    expect(g[Symbol.toPrimitive]).toBeUndefined();
  });
});
