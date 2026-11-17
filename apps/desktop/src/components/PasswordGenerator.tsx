import { useCallback, useEffect, useId, useState } from 'react';
import { generatePassword, generatePassphrase } from '../utils/password';
import StrengthMeter from './StrengthMeter';
import { Button, Checkbox, IconButton, Led, Readout, copyWithClear, useClipboardStatus } from '../theme';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { format } from '../../../../packages/i18n/src/index';

interface PasswordGeneratorProps {
  onUse: (password: string) => void;
}

/**
 * Generator instrument: a length slider with an LCD readout, character-set
 * switches, the result in a recessed well with copy + regenerate keys, the
 * strength LEDs, and a passphrase section. Copies clear after 30 s.
 */
export default function PasswordGenerator({ onUse }: PasswordGeneratorProps) {
  const { dict } = useTranslation();
  const g = dict.generator;
  const lengthId = useId();
  const wordsId = useId();
  const [length, setLength] = useState(20);
  const [symbols, setSymbols] = useState(true);
  const [numbers, setNumbers] = useState(true);
  const [uppercase, setUppercase] = useState(true);
  const [lowercase, setLowercase] = useState(true);
  const [pronounceable, setPronounceable] = useState(false);
  const [generated, setGenerated] = useState('');
  const [passphraseWords, setPassphraseWords] = useState(6);
  const [passphrase, setPassphrase] = useState('');
  const { copiedKey, secondsLeft } = useClipboardStatus();

  const generate = useCallback(() => {
    setGenerated(generatePassword({ length, symbols, numbers, uppercase, lowercase, pronounceable }));
  }, [length, symbols, numbers, uppercase, lowercase, pronounceable]);

  useEffect(() => {
    generate();
  }, [generate]);

  const copied = (key: string) =>
    copiedKey === key ? (
      <span className="ms-copy-led ms-legend" role="status">
        <Led tone="ok" /> {format(dict.itemDetail.copied, secondsLeft)}
      </span>
    ) : null;

  return (
    <div className="grid gap-5">
      <section aria-labelledby={`${lengthId}-title`} className="grid gap-3">
        <h3 id={`${lengthId}-title`} className="ms-legend m-0">{g.password}</h3>
        <div className="ms-field-row">
          <output className="ms-input ms-input--mono flex items-center break-all" aria-label={g.result} aria-live="polite">
            {generated}
          </output>
          <IconButton icon="regenerate" label={g.generate} variant="secondary" onClick={generate} />
          <IconButton icon="copy" label={g.copy} variant="secondary" disabled={!generated} onClick={() => void copyWithClear('gen:password', generated)} />
        </div>
        {copied('gen:password')}
        <StrengthMeter password={generated} />
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <label className="ms-label m-0" htmlFor={lengthId}>{g.length}</label>
            <Readout value={length} />
          </div>
          <input
            id={lengthId}
            type="range"
            min={8}
            max={64}
            value={length}
            onChange={(e) => setLength(Number(e.target.value))}
            className="ms-range"
          />
        </div>
        <fieldset className="m-0 grid gap-2 border-0 p-0 sm:grid-cols-2">
          <legend className="ms-label">{g.options}</legend>
          <Checkbox label={g.symbols} checked={symbols} onChange={(e) => setSymbols(e.target.checked)} />
          <Checkbox label={g.numbers} checked={numbers} onChange={(e) => setNumbers(e.target.checked)} />
          <Checkbox label={g.uppercase} checked={uppercase} onChange={(e) => setUppercase(e.target.checked)} />
          <Checkbox label={g.lowercase} checked={lowercase} onChange={(e) => setLowercase(e.target.checked)} />
          <Checkbox label={g.pronounceable} checked={pronounceable} onChange={(e) => setPronounceable(e.target.checked)} />
        </fieldset>
        <div>
          <Button variant="primary" icon="check" disabled={!generated} onClick={() => onUse(generated)}>
            {g.usePassword}
          </Button>
        </div>
      </section>

      <hr className="ms-rule m-0" />

      <section aria-labelledby={`${wordsId}-title`} className="grid gap-3">
        <h3 id={`${wordsId}-title`} className="ms-legend m-0">{g.passphrase}</h3>
        <p className="ms-text-sm ms-text-muted m-0 ms-prose">{g.passphraseHint}</p>
        <div className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <label className="ms-label m-0" htmlFor={wordsId}>{g.words}</label>
            <Readout value={passphraseWords} />
          </div>
          <input
            id={wordsId}
            type="range"
            min={4}
            max={8}
            value={passphraseWords}
            onChange={(e) => setPassphraseWords(Number(e.target.value))}
            className="ms-range"
          />
        </div>
        <div>
          <Button variant="secondary" icon="generate" onClick={() => setPassphrase(generatePassphrase({ words: passphraseWords }))}>
            {g.generatePassphrase}
          </Button>
        </div>
        {passphrase && (
          <>
            <div className="ms-field-row">
              <output className="ms-input ms-input--mono flex items-center break-all" aria-label={g.resultPassphrase}>
                {passphrase}
              </output>
              <IconButton icon="copy" label={g.copy} variant="secondary" onClick={() => void copyWithClear('gen:passphrase', passphrase)} />
            </div>
            {copied('gen:passphrase')}
            <div>
              <Button variant="secondary" icon="check" onClick={() => onUse(passphrase)}>
                {g.usePassphrase}
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
