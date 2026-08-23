// Choosing scenarios, and saying which scenario each S number stands for.
//
// This used to be one row of toggle pills per chart — one pill per scenario, six
// rows on the region page and six more on the country page. A run with eight
// scenarios wrapped that row onto three lines and pushed the chart down off the
// panel, so the selector is a dropdown now and the names moved into a column
// beside the chart, mirroring the techfuel legend on the other side.
//
// Scenarios are numbered by their rank among the *selected* ones, because that is
// what the chart draws: the scenLabels plugin writes S1, S2, … under the bars it
// actually plots. The pills numbered by rank in the full list instead, so with
// eight scenarios and three ticked the pill read S5 while the bar under it read S2.

import { useEffect, useRef, useState } from 'react';
import { baseFirst } from '../utils/scenarioOrder';

// Same width as the techfuel legend on the other side of the chart.
const KEY_WIDTH = 90;

/** A dropdown standing in for a row of toggles. Closes on Escape and on a click
 *  outside, so it behaves like the native select next to it. */
export default function ScenarioPicker({ t, all, selected, onChange, exclude = [], label = 'Scenarios' }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc  = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const choices = baseFirst(all).filter(s => !exclude.includes(s));
  const picked  = choices.filter(s => selected.has(s));
  if (!choices.length) return null;

  // Keep the scenarios this picker does not own — the reference scenario of a
  // comparison tab is excluded from the list but must survive a click here.
  const set = (next) => onChange(new Set([...all.filter(s => exclude.includes(s) && selected.has(s)), ...next]));
  const toggle = (s) => { const n = new Set(picked); n.has(s) ? n.delete(s) : n.add(s); set(n); };

  const summary = picked.length === 0 ? 'none'
    : picked.length === 1 ? picked[0]
    : `${picked.length} / ${choices.length}`;

  const row = (s, i) => {
    const on = selected.has(s);
    const n  = picked.indexOf(s);
    return (
      <div key={s} onClick={() => toggle(s)}
        style={{ display:'flex', alignItems:'center', gap:5, padding:'3px 7px', cursor:'pointer',
          backgroundColor: on ? 'rgba(74,143,204,0.10)' : 'transparent' }}>
        <span style={{ width:9, height:9, flexShrink:0, borderRadius:2,
          border:`1px solid ${on ? 'rgba(74,143,204,0.8)' : t.panelBorder}`,
          backgroundColor: on ? 'rgba(74,143,204,0.8)' : 'transparent' }}/>
        <span style={{ width:16, flexShrink:0, fontSize:'0.4rem', fontWeight:700,
          color: on ? 'rgba(74,143,204,1)' : 'transparent' }}>{on ? `S${n + 1}` : `S${i + 1}`}</span>
        <span style={{ fontSize:'0.44rem', color: on ? t.muted : t.lblMuted, whiteSpace:'nowrap' }}>{s}</span>
      </div>
    );
  };

  return (
    <div ref={box} style={{ position:'relative', display:'inline-block' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ fontSize:'0.5rem', fontFamily:'inherit', padding:'2px 6px', borderRadius:3,
          border:`1px solid ${open ? 'rgba(74,143,204,0.65)' : t.panelBorder}`,
          backgroundColor:t.panel, color:t.muted, cursor:'pointer',
          display:'flex', alignItems:'center', gap:5, maxWidth:200 }}>
        <span style={{ color:t.lblMuted }}>{label}</span>
        <b style={{ fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{summary}</b>
        <span style={{ fontSize:'0.36rem', color:t.lblMuted }}>{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div style={{ position:'absolute', top:'calc(100% + 3px)', left:0, zIndex:60, minWidth:'100%',
          maxHeight:240, overflowY:'auto', padding:'3px 0', borderRadius:4,
          border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel,
          boxShadow:'0 4px 14px rgba(0,0,0,0.28)' }}>
          {choices.map(row)}
          <div style={{ display:'flex', gap:8, padding:'4px 7px 1px', marginTop:2,
            borderTop:`1px solid ${t.panelBorder}`, fontSize:'0.38rem', color:t.lblMuted }}>
            <span onClick={() => set(new Set(choices))} style={{ cursor:'pointer', textDecoration:'underline' }}>All</span>
            <span onClick={() => set(new Set())} style={{ cursor:'pointer', textDecoration:'underline' }}>None</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The column that says what S1, S2, … are, for the charts that print those
 *  numbers under their bars. `scenarios` must be the list the chart was given,
 *  in the same order, or the numbers stop matching. */
export function ScenarioKey({ t, scenarios, colors }) {
  if (!scenarios || scenarios.length < 2) return null;
  return (
    <div style={{ width:KEY_WIDTH, flexShrink:0, display:'flex', flexDirection:'column',
      gap:3, paddingTop:4, maxHeight:220, overflowY:'auto' }}>
      {scenarios.map((s, i) => (
        <div key={s} style={{ display:'flex', alignItems:'baseline', gap:4 }}>
          <span style={{ width:15, flexShrink:0, fontSize:'0.4rem', fontWeight:700,
            color: colors ? colors[i % colors.length] : t.muted }}>S{i + 1}</span>
          <span style={{ fontSize:'0.4rem', color:t.muted, lineHeight:1.3, overflowWrap:'anywhere' }}>{s}</span>
        </div>
      ))}
    </div>
  );
}
