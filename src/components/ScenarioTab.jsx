import { Fragment, useState } from 'react';
import { baseName } from '../utils/epmScenarios';

function hexA(hex, a) {
  if (!hex || hex.length < 7) return `rgba(128,128,128,${a})`;
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

const GOOD = '#34C759', BAD = '#FF3B30';

/** Longest common trailing word-suffix of a group's values, so a column head can drop what
 *  its group header already says ("Very low + CBAM" under "with CBAM" reads "Very low"). */
function commonSuffix(values) {
  if (values.length < 2) return '';
  let suf = '';
  const parts = values.map(v => v.split(' '));
  const n = Math.min(...parts.map(p => p.length));
  for (let i = 1; i < n; i++) {
    const tail = parts.map(p => p.slice(p.length - i).join(' '));
    if (tail.every(x => x === tail[0])) suf = tail[0]; else break;
  }
  return suf;
}

/**
 * The two axes a schematic view needs, or null when the study has none.
 *
 * A region's doc file declares them (`dimensions`, each with ordered `groups`); the run
 * decides which of their values are real. Values no scenario uses are dropped, so the
 * matrix stays as small as the run actually is. A study that declares no dimensions, which
 * is most of them, simply gets no matrix and falls back to the list.
 */
function buildAxes(docs, scenarios) {
  const dims = docs?.dimensions || [];
  const row = dims.find(d => d.axis === 'row') || dims[0];
  const col = dims.find(d => d.axis === 'col') || dims[1];
  if (!row || !col || row.key === col.key) return null;

  // Axis values carry spaces, so the cell key joins on a character they cannot hold.
  const cells = {};                                  // `rowVal\u0000colVal` -> [scenario]
  const pos = {};                                    // scenario -> its cell, for the cross-hair
  const seenRow = new Set(), seenCol = new Set();
  for (const s of scenarios) {
    const dm = docs?.docFor(s)?.dimensions;
    const rv = dm?.[row.key], cv = dm?.[col.key];
    if (!rv || !cv) continue;
    seenRow.add(rv); seenCol.add(cv);
    pos[s] = { rv, cv };
    (cells[`${rv}\u0000${cv}`] ||= []).push(s);
  }
  if (!Object.keys(cells).length) return null;

  // Declared order wins; anything the doc forgot to declare is appended rather than lost.
  const axis = (dim, seen) => {
    const groups = (dim.groups?.length ? dim.groups : [{ label: dim.label, values: [] }])
      .map(g => ({ label: g.label, values: (g.values || []).filter(v => seen.has(v)) }));
    const declared = new Set(groups.flatMap(g => g.values));
    const rest = [...seen].filter(v => !declared.has(v));
    if (rest.length) groups.push({ label: groups.length > 1 ? 'Other' : dim.label, values: rest });
    return groups.filter(g => g.values.length);
  };

  const rowGroups = axis(row, seenRow), colGroups = axis(col, seenCol);
  const colNotes = col.notes || {};
  const cols = colGroups.flatMap(g => {
    const suf = commonSuffix(g.values);
    return g.values.map((v, i) => ({ value: v, note: colNotes[v] || '',
      label: suf ? v.slice(0, v.length - suf.length - 1) || v : v, first: i === 0 }));
  });
  const placed = new Set(Object.values(cells).flat());
  return {
    rowLabel: row.label, colLabel: col.label, rowGroups, colGroups, cols,
    rowNotes: row.notes || {},
    at: (rv, cv) => cells[`${rv}\u0000${cv}`] || [],
    posOf: s => pos[s] || null,
    unplaced: scenarios.filter(s => !placed.has(s)),
  };
}

/** One scenario, written out: what it is, then the inputs it swaps. */
function ScenarioCard({ t, scen, docs, diff, ben, dense }) {
  const d = docs?.docFor(scen) || null;
  const good = ben && ben.net > 0;
  const chip = (label, value) => (
    <span key={label} style={{ fontSize: '0.4rem', color: t.lblMuted, border: `1px solid ${t.panelBorder}`,
      borderRadius: 3, padding: '1px 5px', whiteSpace: 'nowrap' }}>
      {label}: <b style={{ color: t.muted, fontWeight: 600 }}>{value}</b>
    </span>
  );
  return (
    <div style={{ border: `1px solid ${t.panelBorder}`, borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
        padding: '6px 10px', backgroundColor: hexA(t.panelBorder, 0.35) }}>
        <span style={{ fontSize: '0.55rem', fontWeight: 700, color: t.lbl }}>
          {d?.title || scen}
          {d?.title && <span style={{ fontSize: '0.42rem', fontWeight: 400, color: t.lblMuted, marginLeft: 6 }}>{scen}</span>}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {ben && (
            <span style={{ fontSize: '0.44rem', color: good ? GOOD : BAD, fontWeight: 700 }}>
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
        <div style={{ padding: '4px 0', maxHeight: dense ? 220 : undefined, overflowY: dense ? 'auto' : undefined }}>
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
}

// Recap of the scenarios defined in scenarios.csv: each scenario + the inputs it
// overrides vs the base case (the systematic diff). Self-contained (own search box),
// shared by the region / country / zone EPM input views and by the results pages.
//
// A study of any size is a matrix, not a list: Black Sea runs 34 scenarios that are one
// choice of grid crossed with one choice of EU price path, and stacking 34 cards hides
// both the crossing and the holes in it. When the region's doc file declares its axes the
// tab draws that matrix and opens one card on click; otherwise it lists, as it always did.
//
// Three things are optional, and the tab degrades one at a time rather than all at once:
//   scnMeta  -- the variant diff. Absent for a folder with only a base case.
//   docs     -- the written explanation (utils/scenarioDocs). Absent for a region that
//               has no prose file yet, which is most of them. No docs, no matrix.
//   benefitOf-- net NPV difference against the scenario's own counterfactual, which only
//               a results page can compute. Absent on the inputs pages, where the matrix
//               shows which scenarios exist rather than what they are worth.
export default function ScenarioTab({ t, scnMeta, docs, order, benefitOf }) {
  const [scnFilter, setScnFilter] = useState('');
  const [view, setView] = useState('matrix');
  const [sel, setSel] = useState(null);

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
  const diffOf = s => scnMeta?.diffByScenario?.[s] || [];
  const benOf  = s => benefitOf?.(s) || null;

  // The filter narrows the matrix itself, not just a list under it.
  const axes = buildAxes(docs, list);
  const grid = axes && view === 'matrix';
  const scale = grid
    ? Math.max(...list.map(s => Math.abs(benOf(s)?.net || 0)), 0)
    : 0;

  // Which row and column the open card sits in, so both headers can say so.
  const selAt = grid && sel ? axes.posOf(sel) : null;
  const selRow = selAt?.rv, selCol = selAt?.cv;

  const th = { fontSize: '0.4rem', color: t.lblMuted, fontWeight: 600, padding: '3px 5px',
    textAlign: 'center', whiteSpace: 'nowrap' };
  const cellStyle = (ben, on, firstOfGroup) => {
    const v = ben?.net;
    const col = v == null ? null : v > 0 ? GOOD : BAD;
    return {
      padding: 0, textAlign: 'center', borderTop: `1px solid ${t.panelBorder}`,
      borderLeft: firstOfGroup ? `2px solid ${t.panelBorder}` : `1px solid ${hexA(t.panelBorder, 0.5)}`,
      backgroundColor: col && scale ? hexA(col, Math.min(0.55, (Math.abs(v) / scale) * 0.55)) : 'transparent',
      outline: on ? `2px solid ${t.lbl}` : 'none', outlineOffset: -2,
    };
  };

  const cellBtn = (scen, ben) => {
    const d = docs?.docFor(scen);
    const v = ben?.net;
    // A scenario with no counterfactual declared is one: it is what its column is read
    // against, so the cell says so rather than showing a blank where a benefit would be.
    const isRef = !d?.counterfactual;
    const val = v != null ? `${v > 0 ? '+' : '−'}${(Math.abs(v) / 1000).toFixed(2)}`
      : isRef ? 'ref' : 'n/a';
    return (
      <button key={scen} type="button" onClick={() => setSel(sel === scen ? null : scen)}
        title={`${d?.title || scen} · ${scen}${v != null ? ` · ${v > 0 ? '+' : ''}${(v / 1000).toFixed(2)} bn$ vs ${ben.ref}` : ''}`}
        style={{ display: 'block', width: '100%', border: 'none', background: 'none', cursor: 'pointer',
          font: 'inherit', padding: '4px 7px', textAlign: 'center', whiteSpace: 'nowrap' }}>
        <div style={{ fontSize: '0.36rem', color: t.lblMuted, fontWeight: 400 }}>{scen}</div>
        <div style={{ fontSize: v != null ? '0.5rem' : '0.42rem', fontWeight: v != null ? 700 : 400,
          color: v != null ? t.lbl : t.lblMuted, marginTop: 1 }}>{val}</div>
      </button>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: '0.5rem', color: t.muted, lineHeight: 1.6 }}>
        <b>{all.length}</b> scenario{all.length !== 1 ? 's' : ''}
        {scnMeta?.scenariosFile && <> in <code>{scnMeta.scenariosFile}</code></>}.
        {' '}{grid
          ? <>Read a project across its own row for the price sensitivity, and against the top of its own column for the benefit. A scenario is only comparable to the counterfactual that shares its price path.</>
          : <>Each card shows the inputs a scenario <b>changes from the base case</b> (a △ variant file); everything else uses the default.</>}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input value={scnFilter} onChange={e => { setScnFilter(e.target.value); setSel(null); }}
          placeholder="Filter scenarios…"
          style={{ fontSize: '0.5rem', fontFamily: 'inherit', padding: '4px 8px', borderRadius: 4,
            border: `1px solid ${t.panelBorder}`, backgroundColor: t.panel, color: t.muted, flex: 1 }} />
        {axes && ['matrix', 'list'].map(v => (
          <button key={v} type="button" onClick={() => setView(v)}
            style={{ fontSize: '0.42rem', fontFamily: 'inherit', textTransform: 'uppercase', letterSpacing: '1px',
              padding: '4px 9px', borderRadius: 4, cursor: 'pointer', fontWeight: 700,
              border: `1px solid ${view === v ? t.lbl : t.panelBorder}`,
              backgroundColor: view === v ? hexA(t.panelBorder, 0.5) : 'transparent',
              color: view === v ? t.lbl : t.lblMuted }}>{v}</button>
        ))}
      </div>

      {list.length === 0 && <div style={{ color: t.lblMuted, fontSize: '0.5rem' }}>No scenario matches “{scnFilter}”.</div>}

      {grid && <>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }} />
                {axes.colGroups.map(g => (
                  <th key={g.label} colSpan={g.values.length}
                    style={{ ...th, borderLeft: `2px solid ${t.panelBorder}`, borderBottom: `1px solid ${t.panelBorder}`,
                      letterSpacing: '1px', textTransform: 'uppercase', color: t.muted }}>{g.label}</th>
                ))}
              </tr>
              <tr>
                <th style={{ ...th, textAlign: 'left', letterSpacing: '1px', textTransform: 'uppercase' }}>{axes.rowLabel}</th>
                {axes.cols.map(c => (
                  <th key={c.value} style={{ ...th, borderLeft: c.first ? `2px solid ${t.panelBorder}` : 'none',
                    color: selCol === c.value ? t.lbl : t.muted, verticalAlign: 'bottom' }}>
                    <div style={{ fontSize: '0.48rem', fontWeight: 700 }}>{c.label}</div>
                    {c.note && <div style={{ fontSize: '0.38rem', fontWeight: 400, color: t.lblMuted,
                      whiteSpace: 'normal', maxWidth: 150, margin: '2px auto 0', lineHeight: 1.4 }}>{c.note}</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {axes.rowGroups.map(g => (
                <Fragment key={g.label}>
                  <tr>
                    <td colSpan={axes.cols.length + 1}
                      style={{ fontSize: '0.4rem', color: t.lblMuted, letterSpacing: '1px', textTransform: 'uppercase',
                        fontWeight: 700, padding: '6px 6px 2px', borderTop: `1px solid ${t.panelBorder}` }}>{g.label}</td>
                  </tr>
                  {g.values.map(rv => (
                    <tr key={rv}>
                      <td style={{ padding: '4px 12px 4px 6px', borderTop: `1px solid ${t.panelBorder}`,
                        backgroundColor: selRow === rv ? hexA(t.panelBorder, 0.35) : 'transparent' }}>
                        <div style={{ fontSize: '0.48rem', fontWeight: 700, color: t.lbl, whiteSpace: 'nowrap' }}>{rv}</div>
                        {axes.rowNotes[rv] && <div style={{ fontSize: '0.38rem', color: t.lblMuted,
                          maxWidth: 230, lineHeight: 1.45, marginTop: 1 }}>{axes.rowNotes[rv]}</div>}
                      </td>
                      {axes.cols.map(c => {
                        const here = axes.at(rv, c.value);
                        const on = here.includes(sel);
                        return (
                          <td key={c.value} style={cellStyle(here.length === 1 ? benOf(here[0]) : null, on, c.first)}>
                            {here.map(s => cellBtn(s, benOf(s)))}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ fontSize: '0.4rem', color: t.lblMuted, lineHeight: 1.6 }}>
          {scale > 0
            ? <>Each cell holds the scenario name and its net benefit in bn$ against its own counterfactual, shaded by size.
              {' '}<b>ref</b> marks a counterfactual itself. <b>n/a</b> marks a scenario the run solved but whose cost
              {' '}decomposition does not reconcile with the model NPV, so no benefit is shown. Click a cell to read what
              {' '}the scenario changes. An empty cell was not run.</>
            : <>Each cell holds a scenario the run solved. Click one to read what it changes. An empty cell was not run.</>}
          {axes.unplaced.length > 0 && <>
            {' '}Off the matrix, with no declared axes: {axes.unplaced.map((s, i) => (
              <span key={s}>{i ? ', ' : ''}
                <button type="button" onClick={() => setSel(sel === s ? null : s)}
                  style={{ border: 'none', background: 'none', padding: 0, font: 'inherit', color: t.muted,
                    textDecoration: 'underline', cursor: 'pointer' }}>{s}</button>
              </span>
            ))}.
          </>}
        </div>

        {sel
          ? <ScenarioCard t={t} scen={sel} docs={docs} diff={diffOf(sel)} ben={benOf(sel)} dense />
          : <div style={{ fontSize: '0.46rem', color: t.lblMuted, fontStyle: 'italic' }}>
              Pick a cell to read what that scenario changes.
            </div>}
      </>}

      {!grid && list.map(s => (
        <ScenarioCard key={s} t={t} scen={s} docs={docs} diff={diffOf(s)} ben={benOf(s)} />
      ))}
    </div>
  );
}
