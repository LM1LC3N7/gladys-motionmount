// -----------------------------------------------------------------------------
// The mount read -> a Gladys device (pure).
//
// One Gladys device per MotionMount; nothing a "turn everything off" (voice
// assistants, scenes `switch.*`) could reach: no switch, no binary command.
//   extension  unknown/integer  0 (at the wall) .. 100, read only
//   turn       unknown/integer  -100 .. 100, read only
//   moving     unknown/binary   the motors run, read only
//   status     text/text        "OK" or the errors of the mount, read only
//   preset     text/select      go to a preset (the wall, presets 1..7 set
//                               on the mount): refused unless moves are allowed
//   stop       button/push      stop: always accepted
// No unit: the core lists none for these categories (the positions are
// percent of the travel, not centimetres nor degrees).
//
// Identity rule (frozen: it fixes the external ids): the MAC address read from
// the mount (`mac`, 6 bytes, lower case without separators). An older firmware
// without `mac`, or a MAC of zeros: the mount is not published ("identity
// cannot be read").
//   device   ext:<selector>:motionmount:<12 hex digits>
//   feature  <device>:<key>
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { FEATURES, PRESETS, PRESSED } from './constants.js';
import { label, word, T as TEXTS } from './i18n.js';

const MAC = /^[0-9a-f]{12}$/;

/** The ids of a mount: `{ device, feature(key) }`. */
export const mountIds = (gladys, id) => gladys.externalIds('motionmount', id);

/** The mount id and the feature key of an external id of this integration, or undefined. */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 200) {
    return undefined;
  }
  const prefix = gladys.externalIds('motionmount', 'x').device.slice(0, -1);
  if (!externalId.startsWith(prefix)) {
    return undefined;
  }
  const [id, key, ...rest] = externalId.slice(prefix.length).split(':');
  if (!MAC.test(id ?? '') || rest.length > 0) {
    return undefined;
  }
  return { id, key };
}

/** The name of a mount in Gladys: its own name, else "MotionMount" and the end of its MAC. */
export const nameOf = (info) => info.name || `MotionMount ${info.id.slice(-6)}`;

/** The options of the preset list: the wall, then the active presets 1..7 by number. */
export function presetOptions(presets, language = 'fr') {
  const options = [
    { value: String(PRESETS.wall), label: word(TEXTS.wall, language), sort_order: 0 },
  ];
  for (const preset of [...presets.values()].sort((a, b) => a.index - b.index)) {
    options.push({
      value: String(preset.index),
      label: preset.name
        ? `${preset.index}. ${preset.name}`
        : `${word(TEXTS.preset, language)} ${preset.index}`,
      sort_order: preset.index,
    });
  }
  return options;
}

const sensor = (ids, key, language, type, min, max) => ({
  name: label(key, language),
  external_id: ids.feature(key),
  category: C.UNKNOWN,
  type,
  min,
  max,
  read_only: true,
  has_feedback: false,
  keep_history: true,
});

/**
 * The Gladys device of a mount.
 * @param {{ id: string, name?: string, presets: Map<number, { index: number, name: string }> }} info
 */
export function buildDevice(gladys, info, { language = 'fr' } = {}) {
  const ids = mountIds(gladys, info.id);
  return {
    name: nameOf(info),
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'MOTIONMOUNT_MAC', value: info.id }],
    features: [
      sensor(ids, FEATURES.EXTENSION, language, T.SENSOR.INTEGER, 0, 100),
      sensor(ids, FEATURES.TURN, language, T.SENSOR.INTEGER, -100, 100),
      sensor(ids, FEATURES.MOVING, language, T.SENSOR.BINARY, 0, 1),
      {
        name: label(FEATURES.STATUS, language),
        external_id: ids.feature(FEATURES.STATUS),
        category: C.TEXT,
        type: T.TEXT.TEXT,
        min: 0,
        max: 0,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
      {
        name: label(FEATURES.PRESET, language),
        external_id: ids.feature(FEATURES.PRESET),
        category: C.TEXT,
        type: T.TEXT.SELECT,
        min: 0,
        max: 0,
        read_only: false,
        has_feedback: false,
        keep_history: false,
        supported_options: presetOptions(info.presets, language),
      },
      {
        name: label(FEATURES.STOP, language),
        external_id: ids.feature(FEATURES.STOP),
        category: C.BUTTON,
        type: T.BUTTON.PUSH,
        min: PRESSED,
        max: PRESSED,
        read_only: false,
        has_feedback: false,
        keep_history: false,
      },
    ],
  };
}

/** A value of a command: a finite number, never null nor '' nor a boolean (they are not 0). */
export function numberIn(value, min, max) {
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  if (value === null || value === undefined || typeof value === 'boolean') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

/** The preset a `preset` command asks: 0..7, exactly ("1", 1), or undefined. */
export function presetIndexOf(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= PRESETS.wall && value <= PRESETS.last
      ? value
      : undefined;
  }
  if (typeof value === 'string' && /^[0-7]$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}
