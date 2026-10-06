import type { Ionicons } from '@expo/vector-icons';

import type { PendingKingdom } from '~/db';

/** The three kingdoms a pending observation is kept under, as casual mode draws them. */
export const KINGDOM_ICON: Record<PendingKingdom, keyof typeof Ionicons.glyphMap> = {
  Plantae: 'leaf-outline',
  Animalia: 'paw-outline',
  Fungi: 'umbrella-outline',
};
