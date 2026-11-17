import { passwordStrength } from '../utils/password';
import { useTranslation } from '../../../../packages/i18n/src/react';
import { formatDuration, format, type Dictionary, type Locale } from '../../../../packages/i18n/src/index';

interface StrengthMeterProps {
  password: string;
}

const LEVEL_KEYS = ['veryWeak', 'weak', 'fair', 'strong', 'veryStrong'] as const;

/** passwordStrength() (utils, English) returns fixed feedback sentences; map them to dictionary keys. */
const FEEDBACK_KEYS: Record<string, keyof Dictionary['strength']['feedback']> = {
  'Enter a password': 'enter',
  'This is a commonly used password — choose something unique': 'common',
  'Use at least 8 characters': 'min8',
  'Mix uppercase, lowercase, numbers and symbols': 'mix',
  'A longer password (12+ characters) is much stronger': 'longer',
  'Avoid repeating the same character': 'repeat',
};

const UNIT_WORDS = ['minute', 'hour', 'day', 'month', 'year'] as const;

/** Localize the util's English crack-time phrase ("3 days", "centuries", …). */
function localizeCrackTime(locale: Locale, dict: Dictionary, phrase: string): string {
  if (phrase === 'instant') return dict.strength.instant;
  if (phrase === 'a few seconds') return dict.strength.seconds;
  if (phrase === 'centuries') return dict.strength.centuries;
  if (phrase === 'millennia') return dict.strength.millennia;
  const m = /^(\d+) (minute|hour|day|month|year)s?$/.exec(phrase);
  if (m && (UNIT_WORDS as readonly string[]).includes(m[2])) {
    return formatDuration(locale, Number(m[1]), m[2] as (typeof UNIT_WORDS)[number]);
  }
  return phrase;
}

/**
 * Five LED segments: filled count = score + 1, LED colour by band
 * (red <= weak, amber fair, green strong). The meter role carries the
 * value; the printed level and crack time sit beside it.
 */
export default function StrengthMeter({ password }: StrengthMeterProps) {
  const { dict, locale } = useTranslation();
  const { score, feedback, crackTime } = passwordStrength(password);
  const filled = password.length === 0 ? 0 : score + 1;
  const tone = filled <= 2 ? 'danger' : filled === 3 ? 'attention' : 'ok';
  const level = dict.strength.levels[LEVEL_KEYS[score]];
  return (
    <div className="grid gap-1.5">
      <div
        className="grid grid-cols-5 gap-1"
        role="meter"
        aria-valuenow={filled}
        aria-valuemin={0}
        aria-valuemax={5}
        aria-label={format(dict.strength.meter, password.length === 0 ? dict.strength.empty : level)}
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className={`ms-led-strip__seg${i < filled ? ` ms-seg--${tone}` : ''}`} aria-hidden="true" />
        ))}
      </div>
      {password.length > 0 && (
        <p className="ms-text-sm m-0">
          <strong className="font-semibold">{level}</strong>
          <span className="ms-text-muted"> · {format(dict.strength.crackTime, localizeCrackTime(locale, dict, crackTime))}</span>
        </p>
      )}
      {feedback.length > 0 && (
        <ul className="ms-text-sm ms-text-muted m-0 grid list-disc gap-0.5 pl-4">
          {feedback.map((item) => (
            <li key={item}>{FEEDBACK_KEYS[item] ? dict.strength.feedback[FEEDBACK_KEYS[item]] : item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
