import { useState } from 'react';
import { buildDataWorkbook } from '../utils/xlsxExport';
import { saveBlob } from '../utils/xlsx';

/**
 * "Download all" for a Raw data tab: every file the tab is offering, compiled
 * into one xlsx with a tab per parameter.
 *
 * The work happens in the page, one file at a time, so the button counts them
 * off rather than going quiet -- a folder of forty parameters takes a moment,
 * and a button that only says "Building" reads as a button that has hung.
 *
 * @param items     what to fetch, see buildDataWorkbook
 * @param meta      provenance rows for the Contents sheet
 * @param loadSources  optional, fetches the folder's data sources on click
 * @param scenario  the scenario the items were resolved for, '' for the base files
 * @param extraSheets  sheets to add after Contents, see buildDataWorkbook
 * @param filename  what the download should be called
 */
export default function DownloadAllExcel({
  t, items = [], meta = [], loadSources = null, scenario = '', extraSheets = [], filename, style = {},
}) {
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const [failed, setFailed] = useState(false);
  const total = items.length;

  const go = async () => {
    if (busy || !total) return;
    setBusy(true); setAt(0); setFailed(false);
    try {
      const { blob } = await buildDataWorkbook({
        items, meta, loadSources, scenario, extraSheets, onProgress: (done) => setAt(done),
      });
      saveBlob(blob, filename);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const label = busy ? `Building… ${at}/${total}`
    : failed ? 'Could not build the file'
      : `Download all (Excel, ${total})`;

  return (
    <button onClick={go} disabled={busy || !total}
      title={'One sheet per file. Each opens with what it holds, its unit'
        + (loadSources ? ' and its data sources by country' : '')
        + ', then the table. A Contents sheet lists them all'
        + (loadSources ? ', and a Sources sheet gives the method and confidence of each source' : '')
        + (scenario ? `. Files are those ${scenario} reads, and Contents marks the ones it changes` : '')
        + (extraSheets.length ? `. Also: ${extraSheets.map(x => x.name).join(', ')}` : '')
        + '. A file too large for a workbook is listed on Contents rather than included.'}
      style={{
        fontSize: '0.44rem', fontFamily: 'inherit', padding: '3px 8px', borderRadius: 3,
        border: `1px solid ${t.panelBorder}`, backgroundColor: t.panel, color: t.muted,
        cursor: busy || !total ? 'default' : 'pointer', opacity: busy || !total ? 0.6 : 1,
        whiteSpace: 'nowrap', ...style,
      }}>
      {label}
    </button>
  );
}
