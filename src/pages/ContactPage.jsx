import { Link } from 'react-router-dom';
import { useTheme } from '../App';
import { getT } from '../constants';

function ExternalLink({ href, children }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{
      color: 'rgba(74,143,204,0.88)', textDecoration: 'none',
    }}
      onMouseOver={e => e.currentTarget.style.textDecoration = 'underline'}
      onMouseOut={e => e.currentTarget.style.textDecoration = 'none'}
    >
      {children}
    </a>
  );
}

function LinkCard({ href, icon, label, sub }) {
  const { theme } = useTheme();
  const t = getT(theme);
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 14px', borderRadius: 6,
      border: `1px solid ${t.panelBorder}`,
      backgroundColor: t.cardBg || t.panel,
      textDecoration: 'none',
      transition: 'border-color 0.15s',
      flex: 1, minWidth: 180,
    }}
      onMouseOver={e => e.currentTarget.style.borderColor = 'rgba(74,143,204,0.45)'}
      onMouseOut={e => e.currentTarget.style.borderColor = t.panelBorder}
    >
      <div style={{ color: 'rgba(74,143,204,0.7)', flexShrink: 0 }}>{icon}</div>
      <div>
        <div style={{ fontSize: '0.68rem', fontWeight: 600, color: t.lbl }}>{label}</div>
        {sub && <div style={{ fontSize: '0.55rem', color: t.lblMuted, marginTop: 1 }}>{sub}</div>}
      </div>
    </a>
  );
}

export default function ContactPage() {
  const { theme } = useTheme();
  const t = getT(theme);

  const divider = { borderColor: t.panelBorder, margin: '28px 0' };

  return (
    <div style={{ height: '100%', overflowY: 'auto', backgroundColor: t.bg, color: t.text }}>
      <div style={{ maxWidth: 680, margin: '0 auto', padding: '40px 32px 80px' }}>

        {/* Back */}
        <div style={{ marginBottom: 28 }}>
          <Link to="/" style={{ fontSize: '0.65rem', color: t.muted, letterSpacing: '1px' }}>
            ← Back to map
          </Link>
        </div>

        {/* Header */}
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: t.text, marginBottom: 6 }}>
          About
        </h1>
        <p style={{ fontSize: '0.75rem', color: t.muted, lineHeight: 1.65, marginBottom: 32 }}>
          The Regional Power Explorer is developed by the{' '}
          <ExternalLink href="https://www.worldbank.org">World Bank</ExternalLink>{' '}
          through the{' '}
          <ExternalLink href="https://esmap.org">Energy Sector Management Assistance Program (ESMAP)</ExternalLink>,
          a global knowledge and technical assistance program administered by the World Bank.
        </p>

        {/* GitHub links */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 32 }}>
          <LinkCard
            href="https://github.com/ESMAP-World-Bank-Group"
            label="ESMAP on GitHub"
            sub="github.com/ESMAP-World-Bank-Group"
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
              </svg>
            }
          />
          <LinkCard
            href="https://github.com/ESMAP-World-Bank-Group/epm-explorer"
            label="Regional Power Explorer"
            sub="Source code · epm-explorer"
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <polyline points="16 18 22 12 16 6"/>
                <polyline points="8 6 2 12 8 18"/>
              </svg>
            }
          />
        </div>

        <hr style={divider} />

        {/* See also — EPM */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: '0.48rem', letterSpacing: '2px', fontWeight: 700, color: t.lblMuted, textTransform: 'uppercase', marginBottom: 14 }}>
            See also
          </div>

          <div style={{
            padding: '18px 20px', borderRadius: 8,
            border: `1px solid ${t.panelBorder}`,
            backgroundColor: t.panel,
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
              <div style={{ color: 'rgba(74,143,204,0.65)', flexShrink: 0, paddingTop: 2 }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                </svg>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: t.text, marginBottom: 4 }}>
                  EPM — Electricity Planning Model
                </div>
                <p style={{ fontSize: '0.68rem', color: t.muted, lineHeight: 1.7, margin: '0 0 12px' }}>
                  A capacity expansion and dispatch optimization model for World Bank power sector
                  planning studies. This explorer is the geospatial front-end for visualizing
                  model inputs and country context. Scenario results and planning analytics available via the EPM Suite.
                </p>
                <a href="https://esmap-world-bank-group.github.io/EPM/introduction/introduction/"
                  target="_blank" rel="noopener noreferrer" style={{
                    fontSize: '0.62rem', color: 'rgba(74,143,204,0.88)',
                    border: '1px solid rgba(74,143,204,0.3)', borderRadius: 4,
                    padding: '4px 10px', textDecoration: 'none',
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                  }}>
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                    <polyline points="15 3 21 3 21 9"/>
                    <line x1="10" y1="14" x2="21" y2="3"/>
                  </svg>
                  EPM Documentation
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Footer — discreet email */}
        <p style={{ fontSize: '0.65rem', color: t.lblMuted, opacity: 0.6, lineHeight: 1.7 }}>
          Questions or feedback ·{' '}
          <a href="mailto:mbaronnet@worldbank.org" style={{ color: 'inherit', textDecoration: 'none' }}
            onMouseOver={e => e.currentTarget.style.textDecoration = 'underline'}
            onMouseOut={e => e.currentTarget.style.textDecoration = 'none'}
          >
            mbaronnet@worldbank.org
          </a>
        </p>

      </div>
    </div>
  );
}
