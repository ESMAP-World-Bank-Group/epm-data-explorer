import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import maplibregl from 'maplibre-gl';
import { useTheme } from '../App';
import { getT, mapStyle } from '../constants';

export default function WorldPage() {
  const { theme } = useTheme();
  const t = getT(theme);
  const navigate = useNavigate();
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const [regions, setRegions] = useState(null);
  const [disambig, setDisambig] = useState(null); // {x, y, iso, regions[]}

  useEffect(() => {
    fetch('/data/regions.json').then(r => r.json()).then(d => setRegions(d.regions));
  }, []);

  useEffect(() => {
    if (!containerRef.current || !regions) return;

    // iso → array of available regions (can be 2+ for overlapping pools)
    const isoToRegions = {};
    const available = regions.filter(r => r.status === 'available');
    for (const r of available) {
      for (const c of r.countries) {
        if (!isoToRegions[c.iso]) isoToRegions[c.iso] = [];
        isoToRegions[c.iso].push({ id: r.id, name: r.name, color: r.color, countryName: c.name });
      }
    }
    const availableIsos = Object.keys(isoToRegions);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: mapStyle(theme),
      center: [20, 15],
      zoom: 2.2,
      minZoom: 1.5,
      maxZoom: 9,
      attributionControl: false,
    });
    mapRef.current = map;

    // Close popover on map move
    map.on('movestart', () => setDisambig(null));

    map.on('load', async () => {
      const countries = await fetch('/data/countries_110m.geojson').then(r => r.json());

      countries.features.forEach((f, i) => {
        const p = f.properties;
        let iso = p.ISO_A3 || '-99';
        if (iso === '-99') iso = p.ISO_A3_EH || '-99';
        if (iso === '-99') iso = p.ADM0_A3 || '-99';
        p.ISO_A3 = iso;
        f.id = i;
      });

      map.addSource('countries', { type: 'geojson', data: countries, generateId: false });

      map.addLayer({ id: 'land',    type: 'fill', source: 'countries',
        paint: { 'fill-color': t.land, 'fill-opacity': 1 } });
      map.addLayer({ id: 'borders', type: 'line', source: 'countries',
        paint: { 'line-color': t.worldBdr, 'line-width': t.worldBdrW } });

      if (availableIsos.length) {
        // For countries in multiple pools, use the first pool's color; ambiguous ones get a stripe via opacity trick
        const colorExpr = ['match', ['get', 'ISO_A3'],
          ...availableIsos.flatMap(iso => [iso, isoToRegions[iso][0].color]),
          'transparent',
        ];

        map.addLayer({
          id: 'region-fill',
          type: 'fill',
          source: 'countries',
          filter: ['in', ['get', 'ISO_A3'], ['literal', availableIsos]],
          paint: {
            'fill-color': colorExpr,
            'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.55, 0.28],
          },
        });

        map.addLayer({
          id: 'region-border',
          type: 'line',
          source: 'countries',
          filter: ['in', ['get', 'ISO_A3'], ['literal', availableIsos]],
          paint: { 'line-color': colorExpr, 'line-width': 0.9, 'line-opacity': 0.7 },
        });
      }

      let hoveredId = null;
      const popup = new maplibregl.Popup({
        closeButton: false, closeOnClick: false, offset: 8,
        className: `popup-${theme}`,
      });

      map.on('mousemove', 'region-fill', e => {
        map.getCanvas().style.cursor = 'pointer';
        if (hoveredId !== null)
          map.setFeatureState({ source: 'countries', id: hoveredId }, { hover: false });
        hoveredId = e.features[0].id;
        map.setFeatureState({ source: 'countries', id: hoveredId }, { hover: true });

        const iso = e.features[0].properties.ISO_A3;
        const rs = isoToRegions[iso] || [];
        const countryName = rs[0]?.countryName || iso;
        const subtitle = rs.length > 1
          ? rs.map(r => r.name).join(' · ') + ' · click to choose'
          : (rs[0]?.name || '') + ' · click to explore';
        popup.setLngLat(e.lngLat)
          .setHTML(`<b>${countryName}</b><br><span style="opacity:0.65">${subtitle}</span>`)
          .addTo(map);
      });

      map.on('mouseleave', 'region-fill', () => {
        map.getCanvas().style.cursor = '';
        if (hoveredId !== null)
          map.setFeatureState({ source: 'countries', id: hoveredId }, { hover: false });
        hoveredId = null;
        popup.remove();
      });

      map.on('click', 'region-fill', e => {
        const iso = e.features[0].properties.ISO_A3;
        const rs = isoToRegions[iso];
        if (!rs || rs.length === 0) return;
        if (rs.length === 1) {
          navigate(`/region/${rs[0].id}`);
        } else {
          const pixel = map.project(e.lngLat);
          setDisambig({ x: pixel.x, y: pixel.y, iso, regions: rs });
        }
      });
    });

    return () => { mapRef.current?.remove(); setDisambig(null); };
  }, [regions, theme]);

  return (
    <div style={{ height: 'calc(100vh - 46px)', position: 'relative', backgroundColor: t.bg }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* Disambiguation popover */}
      {disambig && (
        <>
          {/* Invisible backdrop to close on outside click */}
          <div
            onClick={() => setDisambig(null)}
            style={{ position: 'absolute', inset: 0, zIndex: 9 }}
          />
          <div style={{
            position: 'absolute',
            left: disambig.x,
            top: disambig.y,
            transform: 'translate(-50%, -110%)',
            zIndex: 10,
            backgroundColor: t.panel,
            border: `1px solid ${t.panelBorder}`,
            borderRadius: 8,
            padding: '10px 12px',
            boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            minWidth: 160,
          }}>
            <div style={{ fontSize: '0.5rem', letterSpacing: '2px', fontWeight: 700,
              color: t.lblMuted, textTransform: 'uppercase', marginBottom: 8 }}>
              {disambig.regions[0]?.countryName || disambig.iso} · Choose region
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {disambig.regions.map(r => (
                <button
                  key={r.id}
                  onClick={e => { e.stopPropagation(); setDisambig(null); navigate(`/region/${r.id}`); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    background: 'none', border: `1px solid ${r.color}44`,
                    borderRadius: 5, padding: '6px 10px', cursor: 'pointer',
                    color: t.text, fontSize: '0.72rem', fontWeight: 600,
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = `${r.color}22`}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}
                >
                  <span style={{ width: 8, height: 8, borderRadius: 2,
                    backgroundColor: r.color, flexShrink: 0 }} />
                  {r.name}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Region legend */}
      {regions && (
        <div style={{
          position: 'absolute', bottom: 70, left: 24,
          backgroundColor: t.panel, border: `1px solid ${t.panelBorder}`,
          borderRadius: 8, padding: '12px 14px',
          display: 'flex', flexDirection: 'column', gap: 7,
        }}>
          <div style={{ fontSize: '0.52rem', letterSpacing: '2px', fontWeight: 700,
            color: t.lblMuted, textTransform: 'uppercase', marginBottom: 2 }}>
            Power Pools
          </div>
          {regions.map(r => (
            <div
              key={r.id}
              onClick={() => r.status === 'available' && navigate(`/region/${r.id}`)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                cursor: r.status === 'available' ? 'pointer' : 'default',
                opacity: r.status === 'available' ? 1 : 0.38,
              }}
            >
              <span style={{ width: 9, height: 9, borderRadius: 2,
                backgroundColor: r.color, flexShrink: 0 }} />
              <span style={{ fontSize: '0.75rem', color: t.text }}>{r.name}</span>
              {r.status !== 'available' && (
                <span style={{ fontSize: '0.58rem', color: t.lblMuted }}>soon</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
