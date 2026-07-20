import { useEffect, useState } from 'react';
import { Share } from './Share.jsx';
import { Resolve } from './Resolve.jsx';

type Route = 'share' | 'resolve';

function currentRoute(): Route {
  return window.location.pathname.startsWith('/resolve') ? 'resolve' : 'share';
}

export function App() {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onPop = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (next: Route) => {
    window.history.pushState({}, '', next === 'resolve' ? '/resolve' : '/');
    setRoute(next);
  };

  // The two surfaces carry different themes: the public app is an issued
  // document (light by default, outdoors in daylight), the console is a
  // control-room tool (dark regardless of system preference).
  //
  // Applied to <body> rather than a wrapper so the background also covers
  // overscroll — otherwise a rubber-band scroll on iOS flashes white behind a
  // dark console.
  const theme = route === 'resolve' ? 'theme-console' : 'theme-public';

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
            className={route === 'resolve' ? 'nav-item nav-active' : 'nav-item'}
            onClick={() => navigate('resolve')}
          >
            Dispatcher
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
