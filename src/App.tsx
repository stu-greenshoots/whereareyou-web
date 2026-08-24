import { useEffect, useState } from 'react';
import { Share } from './Share.jsx';
import { Resolve } from './Resolve.jsx';
import { Brand } from './Brand.jsx';
import { AccountProvider, useAccount } from './AccountContext.jsx';
import { ConnectivityProvider } from './connectivity.js';
import { ProfileMenu } from './ProfileMenu.jsx';
import { SessionMap } from './SessionMap.jsx';
import type { MapSurface } from './tiles.js';

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
  return (
    <AccountProvider>
      <ConnectivityProvider>
        <AppShell />
      </ConnectivityProvider>
    </AccountProvider>
  );
}

function AppShell() {
  const [route, setRoute] = useState<Route>(currentRoute);
  const { requestOpenMap } = useAccount();

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

  // Dev builds only (dead-code-eliminated from production): mounts the live
  // room with no session behind it, so its UI can be exercised and
  // screenshotted by feeding frames through window.__liveHandlers.
  // /dev-live is the public surface; /lookup/dev-live the console one.
  if (import.meta.env.DEV && window.location.pathname.includes('dev-live')) {
    const params = new URLSearchParams(window.location.search);
    return (
      <div className="app">
        <main className="main">
          <SessionMap
            code="DEVDEV00"
            displayCode="DEVD-EV00"
            role={params.get('role') === 'joiner' ? 'joiner' : 'owner'}
            share={params.get('watch') !== '1'}
            /* The real live room takes SessionMap's default (`live`) on both
               themes — a joined map reads light, dark stays on the operator's
               static resolve panels. The harness mirrors that, with
               ?surface=share|console|live as the escape hatch for eyeballing
               the other basemaps against this scene. */
            {...(params.get('surface') !== null
              ? { surface: params.get('surface') as MapSurface }
              : {})}
            name={params.get('name') ?? 'Dev'}
            initialPosition={{ lat: 51.50809, lon: -0.12789, accuracyM: 12 }}
            onLeave={() => window.history.back()}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="header">
        <button className="brand" onClick={() => navigate('share')} aria-label="whereareyou — home">
          <Brand />
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
          <ProfileMenu
            onOpenSavedMap={(map) => {
              // The share screen is where a map is material — it consumes the
              // request from context once it is mounted.
              requestOpenMap(map);
              navigate('share');
            }}
          />
        </nav>
      </header>

      <main className="main">
        {route === 'share' ? (
          <Share />
        ) : (
          <Resolve
            onOpenSavedMap={(map) => {
              // Same move as the header control: a saved map is material on
              // the share screen, which consumes the request once mounted.
              requestOpenMap(map);
              navigate('share');
            }}
          />
        )}
      </main>

      <footer className="footer">This is a tester page.</footer>
    </div>
  );
}
