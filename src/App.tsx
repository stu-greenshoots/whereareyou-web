import { useEffect, useState } from 'react';
import { Share } from './Share.jsx';
import { Resolve } from './Resolve.jsx';

type Route = 'share' | 'lookup';

/**
 * Everything is resolved against Vite's BASE_URL rather than the site root,
 * because GitHub Pages serves this from `/<repo>/`. Hardcoding `/lookup` would
 * work locally and 404 in the only place real users see it.
 */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

/**
 * `lookup` is the canonical path. `resolve` is kept as an alias because codes
 * already shared by the native share sheet carry that URL in their text, and a
 * link someone has read out or pasted must not stop working because we renamed
 * a screen.
 */
function currentRoute(): Route {
  const path = window.location.pathname.slice(BASE.length);
  return path.startsWith('/lookup') || path.startsWith('/resolve') ? 'lookup' : 'share';
}

export function App() {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (next: Route) => {
    window.history.pushState({}, '', next === 'lookup' ? `${BASE}/lookup` : `${BASE}/`);
    setRoute(next);
  };

  // The two surfaces carry different themes: the public app is an issued
  // document (light by default, outdoors in daylight), the console is a
  // control-room tool (dark regardless of system preference).
  //
  // Applied to <body> rather than a wrapper so the background also covers
  // overscroll — otherwise a rubber-band scroll on iOS flashes white behind a
  // dark console.
  const theme = route === 'lookup' ? 'theme-console' : 'theme-public';

  useEffect(() => {
    document.body.classList.remove('theme-public', 'theme-console');
    document.body.classList.add(theme);
    // Tells the browser which scrollbar and form-control palette to use.
    document.documentElement.style.colorScheme = theme === 'theme-console' ? 'dark' : '';
  }, [theme]);

  return (
    <div className="app">
      <header className="header">
        <button className="brand" onClick={() => navigate('share')}>
          whereareyou
        </button>
        <nav className="nav">
          <button
            className={route === 'share' ? 'nav-item nav-active' : 'nav-item'}
            onClick={() => navigate('share')}
          >
            Share
          </button>
          <button
            className={route === 'lookup' ? 'nav-item nav-active' : 'nav-item'}
            onClick={() => navigate('lookup')}
          >
            Look up
          </button>
        </nav>
      </header>

      <main className="main">
        {route === 'share' ? <Share /> : <Resolve />}
      </main>

      <footer className="footer">
        Prototype. Not connected to any emergency service — for a real emergency, dial 999.
      </footer>
    </div>
  );
}
