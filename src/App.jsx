import { createContext, useContext, useState, Component } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import WorldPage from './pages/WorldPage';
import RegionPage from './pages/RegionPage';
import CountryPage from './pages/CountryPage';
import AboutPage from './pages/AboutPage';
import ContactPage from './pages/ContactPage';
import { getT } from './constants';

export const ThemeCtx = createContext({ theme: 'fog', setTheme: () => {} });
export const useTheme = () => useContext(ThemeCtx);

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace', fontSize: 13, color: '#c00',
          position: 'fixed', inset: 0, backgroundColor: '#fff', overflow: 'auto', zIndex: 9999 }}>
          <b>Runtime error — open browser DevTools (F12) for full stack trace.</b>
          <pre style={{ marginTop: 12, whiteSpace: 'pre-wrap', color: '#333' }}>
            {this.state.error?.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const [theme, setTheme] = useState('fog');
  const t = getT(theme);

  return (
    <ErrorBoundary>
      <ThemeCtx.Provider value={{ theme, setTheme }}>
        <BrowserRouter>
          <div style={{
            display: 'flex', flexDirection: 'column', height: '100vh',
            overflow: 'hidden', backgroundColor: t.bg,
          }}>
            <Navbar />
            <div style={{ flex: 1, overflow: 'hidden', height: 'calc(100vh - 46px)' }}>
              <Routes>
                <Route path="/"                    element={<WorldPage />} />
                <Route path="/region/:regionId"    element={<RegionPage />} />
                <Route path="/country/:iso"        element={<CountryPage />} />
                <Route path="/about"               element={<AboutPage />} />
                <Route path="/contact"             element={<ContactPage />} />
              </Routes>
            </div>
          </div>
        </BrowserRouter>
      </ThemeCtx.Provider>
    </ErrorBoundary>
  );
}
