import { passwordStrength } from '../utils/password';

interface StrengthMeterProps {
  password: string;
}

const SEGMENT_COLORS = ['#c0392b', '#e67e22', '#f1c40f', '#2ecc71', '#27ae60'];

export default function StrengthMeter({ password }: StrengthMeterProps) {
  const { score, label, feedback, crackTime } = passwordStrength(password);
  // Score 0-4 maps to 1-5 filled segments; an empty password fills none.
  const filled = password.length === 0 ? 0 : score + 1;
  const color = filled === 0 ? '#cccccc' : SEGMENT_COLORS[filled - 1];
  return (
    <div>
      <div
        style={{ display: 'flex', gap: 4 }}
        role="meter"
        aria-valuenow={filled}
        aria-valuemin={0}
        aria-valuemax={5}
        aria-label={`Password strength: ${password.length === 0 ? 'empty' : label}`}
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            style={{
              height: 8,
              flex: 1,
              borderRadius: 2,
              background: i < filled ? color : '#e0e0e0',
            }}
          />
        ))}
      </div>
      {password.length > 0 && (
        <p style={{ margin: '6px 0 0' }}>
          <strong>{label}</strong> · estimated crack time: {crackTime}
        </p>
      )}
      {feedback.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {feedback.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
