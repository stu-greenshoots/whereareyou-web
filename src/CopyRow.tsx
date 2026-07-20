import { useCallback, useEffect, useState } from 'react';

export interface CopyRowProps {
  label: string;
  value: string;
  href?: string;
}

/** A labelled value with one-click copy and transient confirmation. */
export function CopyRow({ label, value, href }: CopyRowProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (insecure context, permissions).
      // Selecting the text by hand still works, so fail quietly.
    }
  }, [value]);

  return (
    <div className="copy-row">
      <span className="copy-label">{label}</span>
      <span className="copy-value">
        {href !== undefined ? (
          <a href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        ) : (
          value
        )}
      </span>
      <button className="copy-button" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
