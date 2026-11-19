/** RN style → CSS: the parts whose meaning differs between the two. */
import { describe, expect, it } from 'vitest';
import { toCss } from '../src/rn/style';

describe('toCss flex', () => {
  it('maps RN flex values, not CSS ones', () => {
    expect(toCss({ flex: 1 })).toMatchObject({ flexGrow: 1, flexShrink: 1, flexBasis: '0%' });
    // CSS `flex: 0` would collapse the view to zero height (basis 0).
    expect(toCss({ flex: 0 })).toMatchObject({ flexGrow: 0, flexShrink: 0, flexBasis: 'auto' });
    expect(toCss({ flex: -1 })).toMatchObject({ flexGrow: 0, flexShrink: 1, flexBasis: 'auto' });
    expect(toCss({ flex: 0 })).not.toHaveProperty('flex');
  });
  it('lets explicit flexGrow / flexShrink / flexBasis win', () => {
    expect(toCss([{ flex: 1 }, { flexShrink: 0 }])).toMatchObject({ flexGrow: 1, flexShrink: 0, flexBasis: '0%' });
  });
  it('keeps line heights in pixels', () => {
    expect(toCss({ lineHeight: 18 })).toMatchObject({ lineHeight: '18px' });
  });
});
