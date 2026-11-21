export const RECOVERY_KEY_FILENAME = 'my-secret-recovery-key.txt';

/** The saved file holds the exact key on its own line, under a heading and a one-line warning. */
export function recoveryKeyFileText(key: string, heading: string, warning: string): string {
  return `${heading}\n${warning}\n\n${key}\n`;
}

/** Display-only groups of four; the key is copied and saved exactly as generated. */
export function keyGroups(value: string, groupSize = 4): string[] {
  const groups: string[] = [];
  for (let index = 0; index < value.length; index += groupSize) groups.push(value.slice(index, index + groupSize));
  return groups;
}
