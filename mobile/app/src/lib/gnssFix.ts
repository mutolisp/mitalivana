/**
 * One GNSS fix on demand: ask for location permission, take a high-accuracy
 * position, and say why when there is none (permission refused, no fix).
 *
 * Extracted from the plot environment tab (Phase 0,
 * docs/planned/Modular_survey.md §9) for the survey framework's Location
 * component. The other screens that take a fix still do it inline; they
 * differ in accuracy and in using the last known position, so they move over
 * one at a time, not by copy.
 */
import * as Location from 'expo-location';
import { Alert } from 'react-native';
import i18n from '~/i18n';
import { errText } from './errText';

export type GnssFix = {
  lat: number;
  lng: number;
  /** Horizontal accuracy (m), when the device reports one. */
  accuracy: number | null;
  /** Altitude (m), often null indoors or with a poor signal. */
  altitudeM: number | null;
};

/** Null when permission was refused or no position came (the user was told). */
export async function captureFix(): Promise<GnssFix | null> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') {
    Alert.alert(i18n.t('gnss.permTitle'), i18n.t('gnss.permMsg'));
    return null;
  }
  let pos: Location.LocationObject;
  try {
    pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  } catch (e) {
    Alert.alert(i18n.t('gnss.posFailTitle'), errText(e));
    return null;
  }
  const { latitude, longitude, accuracy, altitude } = pos.coords;
  return { lat: latitude, lng: longitude, accuracy: accuracy ?? null, altitudeM: altitude ?? null };
}
