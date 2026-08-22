import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  apiDeleteMap,
  apiListMaps,
  apiLogin,
  apiLogout,
  apiPatchAccount,
  apiPutMap,
  apiRegister,
  clearLocalMaps,
  loadAccount,
  loadLocalMaps,
  newMapId,
  persistAccount,
  persistLocalMaps,
  type Account,
  type SavedMap,
  type SavedMapData,
} from './account.js';

/**
 * One account, one list of saved maps, for the whole app. Actions return an
 * error message or null so screens can show failures inline without a shared
 * error channel. The context also carries the "open this saved map" handoff
 * from the profile drawer to the share screen — the drawer lives in the
 * header, the map lives in a route, and this is the seam between them.
 */

export interface AccountApi {
  account: Account;
  maps: SavedMap[];
  /** Save under a (new or existing) id. Returns an error message or null. */
  saveMap(name: string, data: SavedMapData, id?: string): Promise<string | null>;
  deleteMap(id: string): Promise<string | null>;
  register(username: string, password: string): Promise<string | null>;
  login(username: string, password: string): Promise<string | null>;
  logout(): Promise<void>;
  /** Local account: sets the display name. Remote: renames on the server. */
  rename(name: string): Promise<string | null>;
  /** Remote accounts only. */
  changePassword(current: string, next: string): Promise<string | null>;
  setAvatar(dataUrl: string | null): Promise<string | null>;
  /** The drawer asked for this map to be opened on the share screen. */
  openMapRequest: SavedMap | null;
  requestOpenMap(map: SavedMap): void;
  consumeOpenMapRequest(): void;
}

const AccountContext = createContext<AccountApi | null>(null);

export function useAccount(): AccountApi {
  const value = useContext(AccountContext);
  if (value === null) throw new Error('useAccount outside AccountProvider');
  return value;
}

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<Account>(loadAccount);
  const [maps, setMaps] = useState<SavedMap[]>(() =>
    loadAccount().kind === 'local' ? loadLocalMaps() : [],
  );
  const [openMapRequest, setOpenMapRequest] = useState<SavedMap | null>(null);

  const adopt = useCallback((next: Account) => {
    persistAccount(next);
    setAccount(next);
  }, []);

  // A remote account's maps live on the server; fetch on sign-in and reload.
  // Failure keeps the last list — the drawer says maps, not "error".
  useEffect(() => {
    if (account.kind !== 'remote') return;
    let cancelled = false;
    void apiListMaps(account.token).then((result) => {
      if (cancelled) return;
      if (result.ok) setMaps(result.data);
      else if (result.status === 401) {
        // The token died while we were away — fall back to a signed-out
        // local account rather than a drawer that errors on every action.
        adopt({ kind: 'local', name: account.name, avatar: account.avatar });
        setMaps(loadLocalMaps());
      }
    });
    return () => {
      cancelled = true;
    };
  }, [account, adopt]);

  const saveMap = useCallback(
    async (name: string, data: SavedMapData, id?: string): Promise<string | null> => {
      const map: SavedMap = { id: id ?? newMapId(), name, savedAt: Date.now(), ...data };
      if (account.kind === 'remote') {
        const result = await apiPutMap(account.token, map);
        if (!result.ok) return result.message;
        setMaps((current) => [map, ...current.filter((m) => m.id !== map.id)]);
        return null;
      }
      setMaps((current) => {
        const next = [map, ...current.filter((m) => m.id !== map.id)];
        persistLocalMaps(next);
        return next;
      });
      return null;
    },
    [account],
  );

  const deleteMap = useCallback(
    async (id: string): Promise<string | null> => {
      if (account.kind === 'remote') {
        const result = await apiDeleteMap(account.token, id);
        if (!result.ok && result.status !== 404) return result.message;
      }
      setMaps((current) => {
        const next = current.filter((m) => m.id !== id);
        if (account.kind === 'local') persistLocalMaps(next);
        return next;
      });
      return null;
    },
    [account],
  );

  /** After sign-in/registration: local saves move UP to the account, so the
      act of getting an account never loses what was saved before it. */
  const migrateLocalMaps = useCallback(async (token: string): Promise<void> => {
    const local = loadLocalMaps();
    for (const map of local) {
      const result = await apiPutMap(token, map);
      if (!result.ok) return; // keep the local copies; retry next sign-in
    }
    clearLocalMaps();
  }, []);

  const register = useCallback(
    async (username: string, password: string): Promise<string | null> => {
      const result = await apiRegister(username, password);
      if (!result.ok) return result.message;
      await migrateLocalMaps(result.data.token);
      adopt({
        kind: 'remote',
        name: result.data.account.username,
        avatar: result.data.account.avatar ?? account.avatar,
        token: result.data.token,
      });
      // A locally-chosen picture is worth keeping on the new account.
      if (result.data.account.avatar === undefined && account.avatar !== null) {
        void apiPatchAccount(result.data.token, { avatar: account.avatar });
      }
      return null;
    },
    [account.avatar, adopt, migrateLocalMaps],
  );

  const login = useCallback(
    async (username: string, password: string): Promise<string | null> => {
      const result = await apiLogin(username, password);
      if (!result.ok) return result.message;
      await migrateLocalMaps(result.data.token);
      adopt({
        kind: 'remote',
        name: result.data.account.username,
        avatar: result.data.account.avatar ?? null,
        token: result.data.token,
      });
      return null;
    },
    [adopt, migrateLocalMaps],
  );

  const logout = useCallback(async (): Promise<void> => {
    if (account.kind === 'remote') {
      void apiLogout(account.token); // best-effort; the local forget is the logout
      adopt({ kind: 'local', name: '', avatar: null });
      setMaps(loadLocalMaps());
    }
  }, [account, adopt]);

  const rename = useCallback(
    async (name: string): Promise<string | null> => {
      const trimmed = name.trim();
      if (account.kind === 'remote') {
        const result = await apiPatchAccount(account.token, { username: trimmed });
        if (!result.ok) return result.message;
        adopt({ ...account, name: result.data.account.username });
        return null;
      }
      adopt({ ...account, name: trimmed });
      return null;
    },
    [account, adopt],
  );

  const changePassword = useCallback(
    async (current: string, next: string): Promise<string | null> => {
      if (account.kind !== 'remote') return 'Only a signed-in account has a password.';
      const result = await apiPatchAccount(account.token, {
        currentPassword: current,
        newPassword: next,
      });
      return result.ok ? null : result.message;
    },
    [account],
  );

  const setAvatar = useCallback(
    async (dataUrl: string | null): Promise<string | null> => {
      if (account.kind === 'remote') {
        const result = await apiPatchAccount(account.token, { avatar: dataUrl });
        if (!result.ok) return result.message;
        adopt({ ...account, avatar: result.data.account.avatar ?? null });
        return null;
      }
      adopt({ ...account, avatar: dataUrl });
      return null;
    },
    [account, adopt],
  );

  const requestOpenMap = useCallback((map: SavedMap) => setOpenMapRequest(map), []);
  const consumeOpenMapRequest = useCallback(() => setOpenMapRequest(null), []);

  const value = useMemo<AccountApi>(
    () => ({
      account,
      maps,
      saveMap,
      deleteMap,
      register,
      login,
      logout,
      rename,
      changePassword,
      setAvatar,
      openMapRequest,
      requestOpenMap,
      consumeOpenMapRequest,
    }),
    [
      account,
      maps,
      saveMap,
      deleteMap,
      register,
      login,
      logout,
      rename,
      changePassword,
      setAvatar,
      openMapRequest,
      requestOpenMap,
      consumeOpenMapRequest,
    ],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}
