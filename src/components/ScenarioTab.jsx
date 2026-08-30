import { useState } from 'react';
import { baseName } from '../utils/epmScenarios';

function hexA(hex, a) {
  if (!hex || hex.length < 7) return `rgba(128,128,128,${a})`;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// Recap of the scenarios defined in scenarios.csv: each scenario + the inputs it
// overrides vs the base case (the systematic diff). Self-contained (own search box),
// shared by the region / country / zone EPM input views and by the results pages.
//
// Three things are optional, and the tab degrades one at a time rather than all at once:
//   scnMeta  -- the variant diff. Absent for a folder with only a base case.
//   docs     -- the written explanation (utils/scenarioDocs). Absent for a region that
//               has no prose file yet, which is most of them.
//   benefitOf-- net NPV difference against the scenario's own counterfactual, which only
//               a results page can compute. Absent on the inputs pages.
export default function ScenarioTab({ t, scnMeta, docs, order, benefitOf }) {
  const [scnFilter, setScnFilter] = useState('');

  // The run's own list wins when there is one: it says what was actually solved, where
  // scenarios.csv says only what could be.
  const all = (order?.length ? order : scnMeta?.scenarios) || [];

  // No matrix and no prose is a normal state, not a failure: the folder may define only a
  // base case, which the input tabs still read from config.csv.
  if (!all.length) {
    return (
      <div style={{ color: t.lblMuted, fontSize: '0.55rem', lineHeight: 1.6 }}>
        No scenario matrix (<code>scenarios.csv</code>) found for this study.
        <div style={{ marginTop: 6, fontSize: '0.5rem' }}>
          EPM drives inputs from <b>config.csv</b> (base case) and <b>scenarios.csv</b>
          {' '}(per–data-type variant overrides). Only the base case was reachable for
          {' '}this branch, so every input uses the config.csv default.
        </div>
      </div>
    );
  }

  const hay = s => `${s} ${docs?.docFor(s)?.title || ''} ${docs?.docFor(s)?.summary || ''}`.toLowerCase();
  const list = all.filter(s => hay(s).includes(scnFilter.toLowerCase()));

  const chip = (label, value) => (
    <span key={label} style={{ fontSize: '0.4rem', color: t.lblMuted, border: `1px solid ${t.panelBorder}`,
      borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap' }}>
      {label}: <b style={{ color: t.muted, fontWeight: 600 }}>{value}</b>
    </span>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: '0.5rem', color: t.muted, lineHeight: 1.6 }}>
        {docs?.intro && <div style={{ marginBottom: 6 }}>{docs.intro}</div>}
        <b>{all.length}</b> scenario{all.length !== 1 ? 's' : ''}
        {scnMeta?.scenariosFile && <> in <code>{scnMeta.scenariosFile}</code></>}.
        {' '}Each card shows the inputs a scenario <b>changes from the base case</b>
        {' '}(a △ variant file); everything else uses the default.
      </div>
      <input value={scnFilter} onChange={e => setScnFilter(e.target.value)}
        placeholder="Filter scenarios…"
        style={{ fontSize: '0.5rem', fontFamily: 'inherit', padding: '4px 8px', borderRadius: 4,
          border: `1px solid ${t.panelBorder}`, backgroundColor: t.panel, color: t.muted, width: '100%' }} />
      {list.length === 0 && <div style={{ color: t.lblMuted, fontSize: '0.5rem' }}>No scenario matches “{scnFilter}”.</div>}
      {list.map(s => {
        const diff = scnMeta?.diffByScenario?.[s] || [];
        const d    = docs?.docFor(s) || null;
        const ben  = benefitOf?.(s) || null;
        const good = ben && ben.net > 0;
        return (
          <div key={s} style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
              padding: '6px 10px', backgroundColor: hexA(t.panelBorder, 0.35) }}>
              <span style={{ fontSize: '0.55rem', fontWeight: 700, color: t.lbl }}>
                {d?.title || s}
                {d?.title && <span style={{ fontSize: '0.42rem', fontWeight: 400, color: t.lblMuted, marginLeft: 6 }}>{s}</span>}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {ben && (
                  <span style={{ fontSize: '0.44rem', color: good ? '#34C759' : '#FF3B30', fontWeight: 700 }}>
                    {good ? '+' : '-'}{(Math.abs(ben.net) / 1000).toFixed(2)} bn$
                    <span style={{ color: t.lblMuted, fontWeight: 400 }}> vs {ben.ref}</span>
                  </span>
                )}
                <span style={{ fontSize: '0.42rem', color: t.lblMuted }}>
                  {diff.length ? `${diff.length} variant${diff.length !== 1 ? 's' : ''}` : 'base only'}
                </span>
              </span>
            </div>

            {d && (
              <div style={{ padding: '7px 10px', borderBottom: `1px solid ${t.panelBorder}` }}>
                <div style={{ fontSize: '0.48rem', color: t.muted, lineHeight: 1.6 }}>{d.summary}</div>
                {(d.detail || []).map((p, i) => (
                  <div key={i} style={{ fontSize: '0.44rem', color: t.lblMuted, lineHeight: 1.6, marginTop: 4 }}>{p}</div>
                ))}
                {d.dimensions && (
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
                    {(docs?.dimensions?.length
                      ? docs.dimensions.filter(x => d.dimensions[x.key]).map(x => [x.label, d.dimensions[x.key]])
                      : Object.entries(d.dimensions)
                    ).map(([label, value]) => chip(label, value))}
                  </div>
                )}
              </div>
            )}

            {diff.length === 0 ? (
              <div style={{ padding: '6px 10px', fontSize: '0.46rem', color: t.lblMuted, fontStyle: 'italic' }}>
                Identical to the base case.
              </div>
            ) : (
              <div style={{ padding: '4px 0' }}>
                {diff.map(x => (
                  <div key={x.paramName} style={{ display: 'grid', gridTemplateColumns: '70px 1fr',
                    gap: 8, padding: '3px 10px', fontSize: '0.44rem', alignItems: 'baseline' }}>
                    <span style={{ color: t.lblMuted }}>{x.section || '—'}</span>
                    <span>
                      <span style={{ color: t.lbl, fontWeight: 600 }}>{x.paramName}</span>
                      <span style={{ color: '#E8A33D', marginLeft: 5 }}>△ {baseName(x.file)}</span>
                      {x.defaultFile && <span style={{ color: t.lblMuted, marginLeft: 5 }}>(default: {baseName(x.defaultFile)})</span>}
                      {x.label && <div style={{ color: t.lblMuted, fontSize: '0.4rem', marginTop: 1 }}>{x.label}</div>}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
