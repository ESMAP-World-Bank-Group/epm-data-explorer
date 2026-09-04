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
 * @param filename  what the download should be called
 */
export default function DownloadAllExcel({ t, items = [], meta = [], filename, style = {} }) {
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);
  const [failed, setFailed] = useState(false);
  const total = items.length;

  const go = async () => {
    if (busy || !total) return;
    setBusy(true); setAt(0); setFailed(false);
    try {
      const { blob } = await buildDataWorkbook({ items, meta, onProgress: (done) => setAt(done) });
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
      title={'One sheet per parameter, plus a Contents sheet saying where each came from. '
        + 'A file too large for a workbook is listed there rather than included.'}
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
