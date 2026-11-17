import { useCallback, useEffect, useState } from 'react';
import { generatePassword, generatePassphrase } from '../utils/password';
import StrengthMeter from './StrengthMeter';

interface PasswordGeneratorProps {
  onUse: (password: string) => void;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export default function PasswordGenerator({ onUse }: PasswordGeneratorProps) {
  const [length, setLength] = useState(20);
  const [symbols, setSymbols] = useState(true);
  const [numbers, setNumbers] = useState(true);
  const [uppercase, setUppercase] = useState(true);
  const [lowercase, setLowercase] = useState(true);
  const [pronounceable, setPronounceable] = useState(false);
  const [generated, setGenerated] = useState('');
  const [copied, setCopied] = useState(false);
  const [passphraseWords, setPassphraseWords] = useState(6);
  const [passphrase, setPassphrase] = useState('');
  const [passphraseCopied, setPassphraseCopied] = useState(false);

  const generate = useCallback(() => {
    setGenerated(
      generatePassword({ length, symbols, numbers, uppercase, lowercase, pronounceable }),
    );
    setCopied(false);
  }, [length, symbols, numbers, uppercase, lowercase, pronounceable]);

  useEffect(() => {
    generate();
  }, [generate]);

  const handleCopy = async () => {
    if (!generated) return;
    setCopied(await copyText(generated));
  };

  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginTop: 8 }}>
      <label style={{ display: 'block' }}>
        Length: {length}
        <input
          type="range"
          min={8}
          max={64}
          value={length}
          onChange={(e) => setLength(Number(e.target.value))}
          style={{ display: 'block', width: '100%' }}
        />
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
        <label>
          <input type="checkbox" checked={symbols} onChange={(e) => setSymbols(e.target.checked)} /> Symbols
        </label>
        <label>
          <input type="checkbox" checked={numbers} onChange={(e) => setNumbers(e.target.checked)} /> Numbers
        </label>
        <label>
          <input type="checkbox" checked={uppercase} onChange={(e) => setUppercase(e.target.checked)} /> Uppercase
        </label>
        <label>
          <input type="checkbox" checked={lowercase} onChange={(e) => setLowercase(e.target.checked)} /> Lowercase
        </label>
        <label>
          <input type="checkbox" checked={pronounceable} onChange={(e) => setPronounceable(e.target.checked)} /> Pronounceable
        </label>
      </div>
      <div style={{ marginTop: 12 }}>
        <button type="button" onClick={generate}>Generate</button>
      </div>
      {generated && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <code style={{ wordBreak: 'break-all', flex: 1 }}>{generated}</code>
            <button type="button" onClick={handleCopy}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <div style={{ marginTop: 8 }}>
            <StrengthMeter password={generated} />
          </div>
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => onUse(generated)}>Use password</button>
          </div>
        </div>
      )}
      <div style={{ borderTop: '1px solid #eee', marginTop: 16, paddingTop: 12 }}>
        <strong>Passphrase</strong>
        <p style={{ margin: '4px 0 8px', color: '#555' }}>
          Memorable words, picked with the system CSPRNG. Use 6+ words for a master passphrase.
        </p>
        <label style={{ display: 'block' }}>
          Words: {passphraseWords}
          <input
            type="range"
            min={4}
            max={8}
            value={passphraseWords}
            onChange={(e) => setPassphraseWords(Number(e.target.value))}
            style={{ display: 'block', width: '100%' }}
            aria-label="Passphrase word count"
          />
        </label>
        <div style={{ marginTop: 8 }}>
          <button type="button" onClick={() => { setPassphrase(generatePassphrase({ words: passphraseWords })); setPassphraseCopied(false); }}>
            Generate passphrase
          </button>
        </div>
        {passphrase && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <code style={{ wordBreak: 'break-all', flex: 1 }}>{passphrase}</code>
              <button type="button" onClick={async () => setPassphraseCopied(await copyText(passphrase))}>
                {passphraseCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={() => onUse(passphrase)}>Use passphrase</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
