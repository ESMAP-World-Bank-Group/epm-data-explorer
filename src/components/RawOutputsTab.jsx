import { useEffect, useState } from 'react';
import { fetchOutputFileList, resultCsvUrl } from '../utils/epmFetch';
import { resultLines, resultLabel } from '../utils/csvMeta';
import RawDataTable from './RawDataTable';

// --- Raw data: the result files a run wrote ---
//
// Unlike the inputs, there is no config.csv on this side to act as an index, and
// the catalogue is not fixed: a merged publish writes 11 CSVs, an older run in
// epm/output writes about 55. fetchOutputFileList works that out per run rather
// than trusting a list written here -- see its fallback chain.
//
// The scenario picker is local to the tab. Every other tab on the results page
// compares scenarios; this one shows one file at a time, and a file belongs to
// exactly one of them.
export default function RawOutputsTab({ t, regionName, branch, outputDir, simRun, scenarioList = [] }) {
  const [scenario, setScenario] = useState('');
  const [files,    setFiles]    = useState(null);
  const [picked,   setPicked]   = useState('');

  // Held as a preference, resolved against what actually exists: a scenario or a
  // file that has gone away leaves the picker on something real instead of blank.
  const scen = scenarioList.includes(scenario) ? scenario : scenarioList[0] || '';

  useEffect(() => {
    if (!branch || !simRun || !scen) return;
    let cancelled = false;
    (async () => {
      const list = await fetchOutputFileList(branch, outputDir, simRun, scen);
      if (!cancelled) setFiles(list);
    })();
    return () => { cancelled = true; };
  }, [branch, outputDir, simRun, scen]);

  const list = files || [];
  const file = list.includes(picked) ? picked : list[0] || '';

  const note = { fontSize: '0.5rem', color: t.lblMuted, padding: '14px 2px' };
  if (!simRun)       return <div style={note}>Pick a run to see its result files.</div>;
  if (files === null) return <div style={note}>Listing files…</div>;
  if (!list.length)  return <div style={note}>This run published no readable CSV for {scen}.</div>;

  const url      = resultCsvUrl(branch, simRun, scen, file, outputDir);
  const filename = file.split('/').pop();

  const sel = { fontSize: '0.44rem', fontFamily: 'inherit', padding: '3px 6px', borderRadius: 3,
    border: `1px solid ${t.panelBorder}`, backgroundColor: t.panel, color: t.muted, cursor: 'pointer' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: '0.44rem' }}>
        <label style={{ display: 'flex', gap: 5, alignItems: 'center', color: t.lblMuted }}>
          Scenario
          <select value={scen} onChange={e => { setScenario(e.target.value); setPicked(''); }}
            disabled={scenarioList.length < 2}
            style={{ ...sel, opacity: scenarioList.length < 2 ? 0.6 : 1 }}>
            {scenarioList.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        <label style={{ display: 'flex', gap: 5, alignItems: 'center', color: t.lblMuted }}>
          File
          <select value={file} onChange={e => setPicked(e.target.value)} style={{ ...sel, maxWidth: 340 }}>
            {/* The csv name is on the heading right under this, so the list reads in words. */}
            {list.map(f => <option key={f} value={f}>{resultLabel(f)}</option>)}
          </select>
        </label>

        <span style={{ color: t.lblMuted }}>{list.length} file{list.length === 1 ? '' : 's'} in this run</span>
      </div>

      <RawDataTable
        key={url} t={t} url={url} filename={filename}
        title={resultLabel(file)}
        missingMsg={`${file} is listed for this run but could not be read.`}
        lines={resultLines({ filename, regionName, branch, simRun, scenario: scen, url })}
      />
    </div>
  );
}
