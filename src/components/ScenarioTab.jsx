import { useState } from 'react';
import { baseName } from '../utils/epmScenarios';

function hexA(hex, a) {
  if (!hex || hex.length < 7) return `rgba(128,128,128,${a})`;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// Recap of the scenarios defined in scenarios.csv: each scenario + the inputs it
// overrides vs the base case (the systematic diff). Self-contained (own search box),
// shared by the region / country / zone EPM input views.
export default function ScenarioTab({ t, scnMeta }) {
  const [scnFilter, setScnFilter] = useState('');

  if (!scnMeta) {
    return (
      <div style={{ color: t.lblMuted, fontSize: '0.55rem', lineHeight: 1.6 }}>
        No scenario definitions (<code>scenarios.csv</code>) found for this study.
        <div style={{ marginTop: 6, fontSize: '0.5rem' }}>
          EPM drives inputs from <b>config.csv</b> (base case) and <b>scenarios.csv</b>
          {' '}(per–data-type variant overrides). None were reachable for this branch.
        </div>
      </div>
    );
  }

  const list = scnMeta.scenarios.filter(s => s.toLowerCase().includes(scnFilter.toLowerCase()));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: '0.5rem', color: t.muted, lineHeight: 1.6 }}>
        <b>{scnMeta.scenarios.length}</b> scenario{scnMeta.scenarios.length !== 1 ? 's' : ''} in
        {' '}<code>{scnMeta.scenariosFile}</code>. Each row shows the inputs a scenario
        {' '}<b>changes from the base case</b> (a △ variant file); everything else uses the default.
      </div>
      <input value={scnFilter} onChange={e => setScnFilter(e.target.value)}
        placeholder="Filter scenarios…"
        style={{ fontSize: '0.5rem', fontFamily: 'inherit', padding: '4px 8px', borderRadius: 4,
          border: `1px solid ${t.panelBorder}`, backgroundColor: t.panel, color: t.muted, width: '100%' }} />
      {list.length === 0 && <div style={{ color: t.lblMuted, fontSize: '0.5rem' }}>No scenario matches “{scnFilter}”.</div>}
      {list.map(s => {
        const diff = scnMeta.diffByScenario[s] || [];
        return (
          <div key={s} style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '6px 10px', backgroundColor: hexA(t.panelBorder, 0.35) }}>
              <span style={{ fontSize: '0.55rem', fontWeight: 700, color: t.lbl }}>{s}</span>
              <span style={{ fontSize: '0.42rem', color: t.lblMuted }}>
                {diff.length ? `${diff.length} variant${diff.length !== 1 ? 's' : ''}` : 'base only'}
              </span>
            </div>
            {diff.length === 0 ? (
              <div style={{ padding: '6px 10px', fontSize: '0.46rem', color: t.lblMuted, fontStyle: 'italic' }}>
                Identical to the base case.
              </div>
            ) : (
              <div style={{ padding: '4px 0' }}>
                {diff.map(d => (
                  <div key={d.paramName} style={{ display: 'grid', gridTemplateColumns: '70px 1fr',
                    gap: 8, padding: '3px 10px', fontSize: '0.44rem', alignItems: 'baseline' }}>
                    <span style={{ color: t.lblMuted }}>{d.section || '—'}</span>
                    <span>
                      <span style={{ color: t.lbl, fontWeight: 600 }}>{d.paramName}</span>
                      <span style={{ color: '#E8A33D', marginLeft: 5 }}>△ {baseName(d.file)}</span>
                      {d.defaultFile && <span style={{ color: t.lblMuted, marginLeft: 5 }}>(default: {baseName(d.defaultFile)})</span>}
                      {d.label && <div style={{ color: t.lblMuted, fontSize: '0.4rem', marginTop: 1 }}>{d.label}</div>}
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
