/** Messages between Veil's content script, its background worker and its toolbar popup. None carries a value. */

/** Content script -> background: what was just hidden, as counts per kind (for the values-free audit log). */
export interface AuditMessage {
  type: 'veil:audit';
  counts: Record<string, number>;
}

/** Content script -> background: how protection stands in this tab (shown on the toolbar icon). */
export interface StatusMessage {
  type: 'veil:status';
  state: TabState;
}

/** ok: protecting. off: switched off here. blind: no message box found, so nothing typed here is checked. */
export type TabState = 'ok' | 'off' | 'blind';

/** Popup -> content script. */
export interface GetTabInfoMessage {
  type: 'veil:tab-info';
}

export interface TabInfo {
  host: string;
  site: string;
  state: TabState;
  /** Placeholders on the page right now. */
  hidden: number;
}

export type VeilMessage = AuditMessage | StatusMessage | GetTabInfoMessage;
