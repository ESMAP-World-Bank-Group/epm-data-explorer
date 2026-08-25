import { useEffect, useMemo, useState } from 'react';
import { csvRecords, annotateCsv } from '../utils/csvMeta';
import { fetchFileSize } from '../utils/epmFetch';

// --- One CSV, shown as it is stored ---
//
// The charts elsewhere in EPM View are all interpretations: quarters averaged,
// blocks weighted, fuels grouped. This shows the file instead -- same values,
// same order, same columns -- for the moment you need to know what the model was
// actually handed rather than what a figure made of it.
//
// Two things it refuses to do. It will not render an unbounded table: EPM's
// hourly files run to millions of rows and pDispatchComplete is 121 MB, which is
// a frozen tab, not a view. And it will not fetch a large file without being
// asked twice. Everything past the cap stays one click away in the download,
// which carries the same provenance header as every other download in the app.

const ROW_CAP    = 500;
const SIZE_LIMIT = 2 * 1024 * 1024;   // above this, fetch only on request

const fmtBytes = (n) => (
  n == null ? '' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB`
    : n >= 1024 ? `${Math.round(n / 1024)} kB` : `${n} B`
);

/**
 * @param url        where the CSV lives (already resolved for R2 vs GitHub)
 * @param filename   name the download should carry
 * @param lines      provenance header lines, from csvMeta's resultLines/inputLines
 * @param unitFor    optional per-row unit resolver, passed through to annotateCsv
 * @param subtitle   one line under the toolbar: unit, description, whatever fits
 * @param missingMsg what to say when the file is not in this folder at all
 */
export default function RawDataTable({ t, url, filename, lines = [], unitFor = null,
  subtitle = '', missingMsg = 'This file is not in this folder.' }) {
  // The parent renders this with key={url}, so switching file makes a new
  // instance rather than a stale one to clean up: no rows of the previous file
  // can survive under the new heading, and there is no reset to get wrong.
  const [text, setText]     = useState(null);
  const [state, setState]   = useState(url ? 'loading' : 'idle');
  const [size, setSize]     = useState(null);
  const [filter, setFilter] = useState('');

  const load = async (cancelled = () => false) => {
    setState('loading');
    try {
      const res = await fetch(url);
      if (cancelled()) return;
      // 404 is the ordinary answer for a parameter config.csv declares but this
      // folder does not ship, so it reads as absence, not as a failure.
      if (res.status === 404) { setState('missing'); return; }
      if (!res.ok) { setState('error'); return; }
      const body = await res.text();
      if (cancelled()) return;
      setText(body);
      setState('ready');
    } catch {
      if (!cancelled()) setState('error');
    }
  };

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    (async () => {
      const bytes = await fetchFileSize(url);
      if (cancelled) return;
      setSize(bytes);
      // Unknown size is treated as small: some hosts refuse content-length, and
      // blocking every one of those files would be worse than one slow load.
      if (bytes != null && bytes > SIZE_LIMIT) { setState('oversize'); return; }
      await load(isCancelled);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // One tokenizer for the whole app: the same csvRecords that annotateCsv uses to
  // append the unit column, so what is shown and what is downloaded cannot drift.
  const parsed = useMemo(() => {
    if (!text) return null;
    const recs = csvRecords(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)
      .filter(r => !(r.fields.length === 1 && r.fields[0] === ''));
    if (!recs.length) return null;
    return { header: recs[0].fields, rows: recs.slice(1).map(r => r.fields) };
  }, [text]);

  // Filtered once, not twice: the count and the rows come out of the same pass,
  // which matters on a file with 60k rows and someone typing into the box.
  const { shown, matched } = useMemo(() => {
    if (!parsed) return { shown: [], matched: 0 };
    const q = filter.trim().toLowerCase();
    const rows = q ? parsed.rows.filter(r => r.some(c => c.toLowerCase().includes(q))) : parsed.rows;
    return { shown: rows.slice(0, ROW_CAP), matched: rows.length };
  }, [parsed, filter]);

  // The download is always the whole file, never the filtered view: a CSV named
  // after a parameter but holding a search result is a trap for whoever opens it.
  const handleDownload = () => {
    if (!text) return;
    const blob = new Blob([annotateCsv(text, { filename, lines, unitFor })], { type: 'text/csv' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(href);
  };

  const note = { fontSize: '0.44rem', color: t.lblMuted, padding: '10px 2px' };
  const btn  = {
    fontSize: '0.44rem', fontFamily: 'inherit', padding: '3px 8px', borderRadius: 3,
    border: `1px solid ${t.panelBorder}`, backgroundColor: t.panel, color: t.muted, cursor: 'pointer',
  };

  if (state === 'idle')    return <div style={note}>Pick a file to see its contents.</div>;
  if (state === 'loading') return <div style={note}>Loading…</div>;
  if (state === 'missing') return <div style={note}>{missingMsg}</div>;
  if (state === 'error')   return <div style={note}>Could not read this file.</div>;
  if (state === 'oversize') return (
    <div style={note}>
      This file is {fmtBytes(size)} — too large to open without asking.{' '}
      <button onClick={() => load()} style={{ ...btn, marginLeft: 4 }}>Load anyway</button>
    </div>
  );
  if (!parsed) return <div style={note}>This file is empty.</div>;

  const capped = matched > shown.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: '0.44rem' }}>
        <input
          value={filter} onChange={e => setFilter(e.target.value)} placeholder="filter rows…"
          style={{ fontSize: '0.44rem', fontFamily: 'inherit', padding: '3px 6px', borderRadius: 3,
            border: `1px solid ${t.panelBorder}`, backgroundColor: t.panel, color: t.text, width: 150 }}
        />
        <span style={{ color: t.lblMuted }}>
          {capped ? `showing ${shown.length} of ${matched.toLocaleString()}` : `${matched.toLocaleString()} row${matched === 1 ? '' : 's'}`}
          {filter.trim() && ` matching · ${parsed.rows.length.toLocaleString()} total`}
          {size != null && ` · ${fmtBytes(size)}`}
        </span>
        <button onClick={handleDownload} style={{ ...btn, marginLeft: 'auto' }}>Download CSV</button>
      </div>

      {subtitle && <div style={{ fontSize: '0.42rem', color: t.lblMuted }}>{subtitle}</div>}

      <div style={{ overflow: 'auto', maxHeight: 480, border: `1px solid ${t.panelBorder}`, borderRadius: 4 }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.42rem', width: '100%',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
          <thead>
            <tr>
              {parsed.header.map((h, i) => (
                <th key={i} style={{ position: 'sticky', top: 0, zIndex: 1, textAlign: 'left',
                  padding: '4px 8px', whiteSpace: 'nowrap', color: t.lbl, fontWeight: 700,
                  backgroundColor: t.cardBg, borderBottom: `1px solid ${t.panelBorder}` }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, ri) => (
              <tr key={ri} style={{ backgroundColor: ri % 2 ? t.cardBg : 'transparent' }}>
                {parsed.header.map((_, ci) => (
                  <td key={ci} style={{ padding: '3px 8px', whiteSpace: 'nowrap', color: t.muted,
                    textAlign: /^-?[\d.]+(e-?\d+)?$/i.test(r[ci] || '') ? 'right' : 'left' }}>
                    {r[ci] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {capped && (
        <div style={{ fontSize: '0.42rem', color: t.lblMuted }}>
          Capped at {ROW_CAP} rows — download for the rest.
        </div>
      )}
    </div>
  );
}
