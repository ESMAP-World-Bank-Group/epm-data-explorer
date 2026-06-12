import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTheme } from '../App';
import { getT } from '../constants';

const FORMSPREE_ID = 'xnjygblb';

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
  const [msg, setMsg] = useState('');
  const [status, setStatus] = useState('idle');

  const divider = { borderColor: t.panelBorder, margin: '28px 0' };

  async function handleSubmit(e) {
    e.preventDefault();
    if (!msg.trim()) return;
    setStatus('sending');
    try {
      const res = await fetch(`https://formspree.io/f/${FORMSPREE_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      setStatus(res.ok ? 'sent' : 'error');
      if (res.ok) setMsg('');
    } catch {
      setStatus('error');
    }
  }

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
          A{' '}<ExternalLink href="https://www.worldbank.org">World Bank</ExternalLink>{' '}
          tool for exploring open-access power sector data at the country level.
          It brings together layers on power plants, transmission infrastructure, renewable energy
          resources, and demand indicators — primarily as a geospatial data companion to the
          Electricity Planning Model (EPM) for energy planning studies.
        </p>

        {/* GitHub — main repo */}
        <a href="https://github.com/ESMAP-World-Bank-Group/epm-data-explorer"
          target="_blank" rel="noopener noreferrer"
          style={{
            display: 'flex', alignItems: 'center', gap: 18,
            padding: '22px 24px', borderRadius: 8, marginBottom: 32,
            border: `1px solid ${t.panelBorder}`,
            backgroundColor: t.panel,
            textDecoration: 'none', transition: 'border-color 0.15s',
          }}
          onMouseOver={e => e.currentTarget.style.borderColor = 'rgba(74,143,204,0.45)'}
          onMouseOut={e => e.currentTarget.style.borderColor = t.panelBorder}
        >
          <div style={{ color: 'rgba(74,143,204,0.7)', flexShrink: 0 }}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
            </svg>
          </div>
          <div>
            <div style={{ fontSize: '0.95rem', fontWeight: 700, color: t.text, marginBottom: 4 }}>EPM Data Explorer</div>
            <div style={{ fontSize: '0.6rem', color: t.muted }}>github.com/ESMAP-World-Bank-Group/epm-data-explorer</div>
          </div>
        </a>

        <hr style={divider} />

        {/* See also */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: '0.48rem', letterSpacing: '2px', fontWeight: 700, color: t.lblMuted, textTransform: 'uppercase', marginBottom: 14 }}>
            See also
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <LinkCard
              href="https://github.com/ESMAP-World-Bank-Group/EPM"
              label="EPM"
              sub="Electricity Planning Model"
              icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
                </svg>
              }
            />
            <LinkCard
              href="https://github.com/ESMAP-World-Bank-Group/regional-power-explorer"
              label="Regional Explorer"
              sub="Regional Power Explorer"
              icon={
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/>
                </svg>
              }
            />
          </div>
        </div>

        {/* Feedback form */}
        <div>
          <div style={{ fontSize: '0.44rem', letterSpacing: '2px', fontWeight: 700, color: t.lblMuted, textTransform: 'uppercase', marginBottom: 14 }}>
            Questions or feedback
          </div>
          {status === 'sent' ? (
            <div style={{
              padding: '14px 16px', borderRadius: 6,
              backgroundColor: 'rgba(64,192,87,0.08)',
              border: '1px solid rgba(64,192,87,0.25)',
              fontSize: '0.7rem', color: t.muted,
            }}>
              Message sent — thanks!
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              <textarea
                value={msg}
                onChange={e => { setMsg(e.target.value); if (status === 'error') setStatus('idle'); }}
                placeholder="Your message…"
                rows={4}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  padding: '10px 12px', borderRadius: 6,
                  border: `1px solid ${status === 'error' ? 'rgba(250,82,82,0.5)' : t.panelBorder}`,
                  backgroundColor: t.panel, color: t.text,
                  fontSize: '0.72rem', lineHeight: 1.6,
                  resize: 'vertical', outline: 'none',
                  fontFamily: 'inherit',
                }}
                onFocus={e => e.target.style.borderColor = 'rgba(74,143,204,0.5)'}
                onBlur={e => e.target.style.borderColor = status === 'error' ? 'rgba(250,82,82,0.5)' : t.panelBorder}
              />
              {status === 'error' && (
                <div style={{ fontSize: '0.6rem', color: 'rgba(250,82,82,0.8)', marginTop: 4 }}>
                  Something went wrong — try again or email mbaronnet@worldbank.org
                </div>
              )}
              <button
                type="submit"
                disabled={status === 'sending' || !msg.trim()}
                style={{
                  marginTop: 10, padding: '7px 18px', borderRadius: 5,
                  border: '1px solid rgba(74,143,204,0.35)',
                  backgroundColor: 'rgba(74,143,204,0.12)',
                  color: status === 'sending' || !msg.trim() ? t.muted : 'rgba(74,143,204,0.9)',
                  fontSize: '0.65rem', fontWeight: 600, cursor: status === 'sending' || !msg.trim() ? 'default' : 'pointer',
                  transition: 'opacity 0.15s',
                }}
              >
                {status === 'sending' ? 'Sending…' : 'Send'}
              </button>
            </form>
          )}
        </div>

      </div>
    </div>
  );
}
