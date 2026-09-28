/**
 * The trail protocol's fixed vocabularies, stored as these English values
 * (the UI shows translated labels). Sources: Trail protocol (1) 3–4, p. 4;
 * (2) h, m, n, p. 5; (3) r, s, t, p. 5; definitions p. 7.
 */

/** (2) m trail substrate. */
export const TRAIL_SUBSTRATES = ['bare-soil', 'mown-grass', 'paved', 'dirt', 'steel-mesh', 'board-walk'] as const;

/** (1) 4 / (2) n type of recreational activity. */
export const TRAIL_ACTIVITIES = ['hiking', 'mountain-biking', 'horse-riding', 'trail-bike-riding', 'motorized'] as const;

/** (2) h mountain zone (Körner; FGDC). */
export const MOUNTAIN_ZONES = ['lowland', 'montane', 'alpine', 'nival'] as const;

/** (3) r habitat. */
export const HABITATS = ['forb-grass', 'shrubland', 'open-forest', 'closed-forest', 'bare-rock', 'riparian-wetland'] as const;

/** (3) s disturbance type. */
export const DISTURBANCE_TYPES = ['none', 'human', 'animal', 'environmental'] as const;

/** Optional herbivore type levels: i = invertebrate, v = vertebrate, b = both. */
export const HERBIVORE_TYPES = ['i', 'v', 'b'] as const;
