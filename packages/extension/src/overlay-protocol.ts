/**
 * What the content script tells the overlay frame: where each placeholder sits and how its text
 * looks. Never the values: the frame reads those itself from the extension's session storage,
 * so real values never pass through the page.
 */
export interface Chip {
  /** Canonical placeholder, e.g. "[EMAIL_1]". */
  placeholder: string;
  /** Viewport coordinates of the placeholder (and its padding), in CSS pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Computed CSS of the text around it, so the value blends in. */
  font: string;
  color: string;
  background: string;
  letterSpacing: string;
  /** Insets (top, right, bottom, left) that keep the value inside scrolling areas. */
  clip: [number, number, number, number];
}

export interface ChipsMessage {
  type: 'veil:chips';
  chips: Chip[];
}

export const SITE_ORIGINS = ['https://chatgpt.com', 'https://claude.ai', 'https://gemini.google.com'];

export const vaultKey = (host: string): string => `vault:${host}`;
