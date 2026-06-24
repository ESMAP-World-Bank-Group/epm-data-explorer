import { baseName } from '../utils/epmScenarios';

// Dropdown to swap a single data type to a scenario variant file.
// Always rendered as an affordance: when scenarios.csv has no variant for this
// param (or no scenarios file at all) it still shows, disabled, on "Default".
export default function VariantPicker({ t, scnMeta, param, value, onChange }) {
  const variants    = scnMeta?.variantsForParam?.(param) || [];
  const meta        = scnMeta?.paramMeta?.[param];
  const isVariant   = !!value;
  const hasVariants = variants.length > 0;
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:10, flexWrap:'wrap',
      fontSize:'0.44rem', color:t.muted, padding:'5px 8px', borderRadius:4,
      border:`1px solid ${isVariant ? '#E8A33D66' : t.panelBorder}`,
      backgroundColor:isVariant ? '#E8A33D14' : 'transparent' }}>
      <span style={{ color:t.lblMuted, fontWeight:600 }}>{isVariant ? '△ Variant' : 'Variant'}</span>
      <span style={{ color:t.lblMuted }}>{param}</span>
      <select value={value || ''} onChange={e => onChange(param, e.target.value || null)}
        disabled={!hasVariants}
        style={{ fontSize:'0.44rem', fontFamily:'inherit', padding:'2px 5px', borderRadius:3,
          border:`1px solid ${t.panelBorder}`, backgroundColor:t.panel, color:t.muted,
          cursor:hasVariants ? 'pointer' : 'default', opacity:hasVariants ? 1 : 0.6, maxWidth:220 }}>
        <option value="">Default{meta?.defaultFile ? ` · ${baseName(meta.defaultFile)}` : ''}</option>
        {variants.map(f => <option key={f} value={f}>{baseName(f)}</option>)}
      </select>
      {!hasVariants && <span style={{ color:t.lblMuted, fontSize:'0.4rem' }}>· no variants yet</span>}
      {meta?.unit && <span style={{ color:t.lblMuted, fontSize:'0.4rem' }}>· {meta.unit}</span>}
    </div>
  );
}