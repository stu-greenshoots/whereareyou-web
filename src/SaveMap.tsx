import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount } from './AccountContext.jsx';
import type { SavedMapData } from './account.js';

/**
 * The one save affordance, used everywhere a map can be kept: my own share,
 * a code I looked up, a live session I joined. Saving is deliberate and
 * NAMED — the button opens a name prompt rather than silently filing
 * something away, because a list of "Saved map 14:32" entries is a list
 * nobody can use in a hurry.
 *
 * `data` is a function so the snapshot is taken at save time, not at render
 * time — on a live map the position keeps moving under the button.
 */
export function SaveMapButton({
  data,
  suggestedName = '',
  className = 'button',
}: {
  data: () => SavedMapData;
  suggestedName?: string;
  className?: string;
}) {
  const { saveMap, account } = useAccount();
  const [prompting, setPrompting] = useState(false);
  const [name, setName] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (prompting) inputRef.current?.focus();
  }, [prompting]);

  const open = useCallback(() => {
    setName(suggestedName);
    setError(null);
    setState('idle');
    setPrompting(true);
  }, [suggestedName]);

  const save = useCallback(async () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Give it a name you will recognise later.');
      return;
    }
    setState('busy');
    setError(null);
    const failure = await saveMap(trimmed, data());
    if (failure !== null) {
      setState('idle');
      setError(failure);
      return;
    }
    setState('saved');
    setPrompting(false);
  }, [name, data, saveMap]);

  if (state === 'saved') {
    return (
      <p className="save-confirm" role="status">
        ✓ Saved{account.kind === 'local' ? ' on this device' : ' to your account'}
      </p>
    );
  }

  if (!prompting) {
    return (
      <button type="button" className={className} onClick={open}>
        Save this map
      </button>
    );
  }

  return (
    <div className="save-prompt">
      <label className="field-label" htmlFor="save-map-name">
        Name this map
      </label>
      <input
        id="save-map-name"
        ref={inputRef}
        className="note-input"
        value={name}
        maxLength={80}
        placeholder="Blue tent by the weir"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void save();
          }
        }}
      />
      {account.kind === 'local' && (
        <p className="panel-hint save-hint">
          Saved on this device only. Sign in from the account menu to keep maps across devices.
        </p>
      )}
      {error !== null && <p className="parse-bad">{error}</p>}
      <div className="row">
        <button
          type="button"
          className="button button-primary"
          disabled={state === 'busy'}
          onClick={() => void save()}
        >
          {state === 'busy' ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="button" onClick={() => setPrompting(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
