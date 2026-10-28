/** Kinds of sensitive values the engine can find. Each kind gets its own placeholder prefix, e.g. [EMAIL_1]. */
export type EntityType =
  | 'EMAIL'
  | 'PHONE'
  | 'IBAN'
  | 'CARD'
  | 'IP'
  | 'API_KEY'
  | 'PRIVATE_KEY'
  | 'JWT'
  | 'SECRET';

/** One sensitive value found in a text. Offsets are UTF-16 indices, `end` exclusive. */
export interface Finding {
  type: EntityType;
  start: number;
  end: number;
  value: string;
  /** Name of the rule that found it, useful for debugging false positives. */
  detector: string;
}

/** A rule that finds one kind of sensitive value. */
export interface Detector {
  name: string;
  type: EntityType;
  /** On overlapping findings, the higher priority wins; on a tie, the longer span wins. */
  priority: number;
  find(text: string): Finding[];
}
