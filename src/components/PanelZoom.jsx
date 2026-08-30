import { useCallback, useEffect, useState } from 'react';

const KEY = 'epm.panelZoom';
const MIN = 0.9, MAX = 1.7, STEP = 0.1, DEFAULT = 1.15;
const clamp = z => Math.min(MAX, Math.max(MIN, Math.round(z * 10) / 10));

/**
 * How large the right-hand panel draws itself, remembered per browser.
 *
 * Every size in the app is a fraction of a rem against `html { font-size: 20px }`, so there
 * is no single font knob to turn: the lever is CSS `zoom` on the panel, which — unlike
 * `transform: scale` — reflows, so text rewraps and tables stay inside the panel.
 */
export function usePanelZoom() {
  const [zoom, setZoom] = useState(() => {
    const v = parseFloat(typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : '');
    return Number.isFinite(v) ? clamp(v) : DEFAULT;
  });
  useEffect(() => { try { localStorage.setItem(KEY, String(zoom)); } catch { /* private mode */ } }, [zoom]);
  const inc   = useCallback(() => setZoom(z => clamp(z + STEP)), []);
  const dec   = useCallback(() => setZoom(z => clamp(z - STEP)), []);
  const reset = useCallback(() => setZoom(DEFAULT), []);
  return { zoom, inc, dec, reset };
}

/**
 * A length written back in the panel's own units. `zoom: z` renders a computed length z
 * times larger, so the panel's outer box has to be divided by z to keep the width the user
 * dragged and the height of the viewport.
 */
export function unzoom(value, zoom) {
  if (value == null || zoom === 1) return value;
  if (typeof value === 'number') return value / zoom;
  const s = String(value).trim();
  if (s.endsWith('%')) return `${parseFloat(s) / zoom}%`;
  return `calc((${s}) / ${zoom})`;
}

/** A− / percentage / A+, sitting at the top right of the panel it scales. */
export default function PanelZoomControl({ t, zoom, inc, dec, reset }) {
  const btn = {
    font: 'inherit', fontSize: '0.42rem', fontWeight: 700, lineHeight: 1, cursor: 'pointer',
    padding: '2px 6px', borderRadius: 3, border: `1px solid ${t.panelBorder}`,
    backgroundColor: 'transparent', color: t.lblMuted,
  };
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 3, marginBottom: 6 }}>
      <button type="button" onClick={dec} disabled={zoom <= MIN} title="Smaller text" style={btn}>A−</button>
      <button type="button" onClick={reset} title="Reset text size"
        style={{ ...btn, border: 'none', minWidth: 34, color: t.muted }}>{Math.round(zoom * 100)}%</button>
      <button type="button" onClick={inc} disabled={zoom >= MAX} title="Larger text" style={{ ...btn, fontSize: '0.5rem' }}>A+</button>
    </div>
  );
}
