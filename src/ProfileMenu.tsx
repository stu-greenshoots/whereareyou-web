import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount } from './AccountContext.jsx';
import { fileToAvatar, type SavedMap } from './account.js';

/**
 * The account, as a screen edge: a small round button in the header, and a
 * drawer that slides in from the right with the saved maps and the account
 * actions. Kept deliberately quiet — this app's first job is the share
 * button, and an account is a convenience beside it, never in front of it.
 *
 * The drawer is one flat surface with ruled sections (no modal stack): saved
 * maps first because they are the thing you came for; identity below;
 * credentials folded away in <details> like every other secondary control in
 * the app.
 */

function initialOf(name: string): string {
  const first = name.trim().charAt(0).toUpperCase();
  return /^[A-Z0-9]$/i.test(first) ? first : '';
}

export function ProfileMenu({ onOpenSavedMap }: { onOpenSavedMap: (map: SavedMap) => void }) {
  const account = useAccount();
  const [open, setOpen] = useState(false);

  // Esc closes, like every dismissable surface should.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const initial = initialOf(account.account.name);

  return (
    <>
      <button
        type="button"
        className="profile-button"
        aria-label="Your account"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {account.account.avatar !== null ? (
          <img className="profile-face" src={account.account.avatar} alt="" />
        ) : initial !== '' ? (
          <span className="profile-initial">{initial}</span>
        ) : (
          <span className="profile-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="8.5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path
                d="M4.8 19.5c1.4-3.2 4.1-4.8 7.2-4.8s5.8 1.6 7.2 4.8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Invisible click-away target — the system uses no scrims. */}
          <div className="drawer-cover" onClick={() => setOpen(false)} />
          <aside className="drawer" role="dialog" aria-label="Your account">
            <Drawer
              onClose={() => setOpen(false)}
              onOpenSavedMap={(map) => {
                setOpen(false);
                onOpenSavedMap(map);
              }}
            />
          </aside>
        </>
      )}
    </>
  );
}

function Drawer({
  onClose,
  onOpenSavedMap,
}: {
  onClose: () => void;
  onOpenSavedMap: (map: SavedMap) => void;
}) {
  const { account, maps, deleteMap, rename, setAvatar, logout } = useAccount();
  const [nameDraft, setNameDraft] = useState(account.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setNameDraft(account.name), [account.name]);

  const pickAvatar = useCallback(
    async (file: File | undefined) => {
      if (file === undefined) return;
      setAvatarError(null);
      try {
        const dataUrl = await fileToAvatar(file);
        const failure = await setAvatar(dataUrl);
        if (failure !== null) setAvatarError(failure);
      } catch {
        setAvatarError('Could not read that image.');
      }
    },
    [setAvatar],
  );

  const submitName = useCallback(async () => {
    const failure = await rename(nameDraft);
    setNameError(failure);
  }, [rename, nameDraft]);

  return (
    <div className="drawer-inner">
      <div className="drawer-head">
        <div className="drawer-identity">
          {account.avatar !== null && <img className="drawer-face" src={account.avatar} alt="" />}
          <div>
            <p className="drawer-name">{account.name !== '' ? account.name : 'No name yet'}</p>
            <p className="drawer-kind">
              {account.kind === 'remote' ? 'Signed in' : 'On this device only'}
            </p>
          </div>
        </div>
        <button type="button" className="link-button" onClick={onClose}>
          Close
        </button>
      </div>

      <section className="drawer-section">
        <h2 className="panel-title">Saved maps</h2>
        {maps.length === 0 ? (
          <p className="panel-hint">
            Nothing saved yet. When you share a location or look one up, "Save this map" keeps it
            here.
          </p>
        ) : (
          <ul className="saved-list">
            {maps.map((map) => (
              <li key={map.id} className="saved-row">
                <button type="button" className="saved-open" onClick={() => onOpenSavedMap(map)}>
                  <span className="saved-name">{map.name}</span>
                  <span className="saved-meta">
                    {map.source === 'share'
                      ? 'Shared by you'
                      : map.source === 'lookup'
                        ? 'Looked up'
                        : 'Live session'}
                    {' · '}
                    {new Date(map.savedAt).toLocaleDateString([], {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </span>
                </button>
                <button
                  type="button"
                  className="link-button saved-delete"
                  onClick={() => void deleteMap(map.id)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
        {account.kind === 'local' && maps.length > 0 && (
          <p className="panel-hint">
            These live in this browser only. Sign in below to keep them across devices.
          </p>
        )}
      </section>

      <section className="drawer-section">
        <h2 className="panel-title">Your name</h2>
        <p className="panel-hint">Shown beside your dot when you join a live map.</p>
        <div className="row">
          <input
            className="note-input"
            value={nameDraft}
            maxLength={30}
            placeholder="Your name"
            onChange={(event) => setNameDraft(event.target.value)}
          />
          <button
            type="button"
            className="button"
            disabled={nameDraft.trim() === account.name || nameDraft.trim() === ''}
            onClick={() => void submitName()}
          >
            {account.kind === 'remote' ? 'Rename' : 'Set'}
          </button>
        </div>
        {nameError !== null && <p className="parse-bad">{nameError}</p>}
      </section>

      <section className="drawer-section">
        <h2 className="panel-title">Your photo</h2>
        <p className="panel-hint">Shown inside your dot on the map, to you and to anyone in a live session with you.</p>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="file-hidden"
          onChange={(event) => void pickAvatar(event.target.files?.[0])}
        />
        <div className="row">
          <button type="button" className="button" onClick={() => fileRef.current?.click()}>
            {account.avatar !== null ? 'Change photo' : 'Add a photo'}
          </button>
          {account.avatar !== null && (
            <button type="button" className="button" onClick={() => void setAvatar(null)}>
              Remove
            </button>
          )}
        </div>
        {avatarError !== null && <p className="parse-bad">{avatarError}</p>}
      </section>

      {account.kind === 'local' ? <SignInSection /> : <SignedInSection onLogout={logout} />}
    </div>
  );
}

function SignInSection() {
  const { login, register } = useAccount();

  return (
    <section className="drawer-section">
      <h2 className="panel-title">Account</h2>
      <p className="panel-hint">
        Optional. An account keeps your saved maps on the server, reachable from any device —
        anything already saved here moves over when you sign in.
      </p>
      <CredentialsForm
        summary="Sign in"
        action="Sign in"
        onSubmit={login}
      />
      <CredentialsForm
        summary="Create an account"
        action="Create account"
        hint="Just a username and password — no email. There is no reset: a forgotten password is a lost account."
        onSubmit={register}
      />
    </section>
  );
}

function CredentialsForm({
  summary,
  action,
  hint,
  onSubmit,
}: {
  summary: string;
  action: string;
  hint?: string;
  onSubmit: (username: string, password: string) => Promise<string | null>;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    const failure = await onSubmit(username.trim(), password);
    setBusy(false);
    if (failure !== null) setError(failure);
  }, [onSubmit, username, password]);

  return (
    <details className="drawer-fold">
      <summary>{summary}</summary>
      {hint !== undefined && <p className="panel-hint">{hint}</p>}
      <form
        className="stacked-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          className="note-input"
          value={username}
          placeholder="Username"
          autoComplete="username"
          maxLength={30}
          onChange={(event) => setUsername(event.target.value)}
        />
        <input
          className="note-input"
          type="password"
          value={password}
          placeholder="Password"
          autoComplete="current-password"
          onChange={(event) => setPassword(event.target.value)}
        />
        {error !== null && <p className="parse-bad">{error}</p>}
        <button
          type="submit"
          className="button button-primary"
          disabled={busy || username.trim() === '' || password === ''}
        >
          {busy ? 'Working…' : action}
        </button>
      </form>
    </details>
  );
}

function SignedInSection({ onLogout }: { onLogout: () => Promise<void> }) {
  const { changePassword } = useAccount();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setBusy(true);
    const failure = await changePassword(current, next);
    setBusy(false);
    if (failure !== null) {
      setOutcome(failure);
      return;
    }
    setOutcome('Password changed.');
    setCurrent('');
    setNext('');
  }, [changePassword, current, next]);

  return (
    <section className="drawer-section">
      <h2 className="panel-title">Account</h2>
      <details className="drawer-fold">
        <summary>Change password</summary>
        <form
          className="stacked-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            className="note-input"
            type="password"
            value={current}
            placeholder="Current password"
            autoComplete="current-password"
            onChange={(event) => setCurrent(event.target.value)}
          />
          <input
            className="note-input"
            type="password"
            value={next}
            placeholder="New password (8 or more characters)"
            autoComplete="new-password"
            onChange={(event) => setNext(event.target.value)}
          />
          {outcome !== null && (
            <p className={outcome === 'Password changed.' ? 'panel-hint' : 'parse-bad'}>{outcome}</p>
          )}
          <button
            type="submit"
            className="button"
            disabled={busy || current === '' || next.length < 8}
          >
            {busy ? 'Working…' : 'Change password'}
          </button>
        </form>
      </details>
      <button type="button" className="button drawer-signout" onClick={() => void onLogout()}>
        Sign out
      </button>
      <p className="panel-hint">Signing out leaves your saved maps on the server, ready for next time.</p>
    </section>
  );
}
