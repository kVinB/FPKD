import type { TagKind } from './types';

export const MAX_TAGS_PER_ANSWER = 12;
export const MAX_TAG_LABEL_CODE_POINTS = 40;
export const MIN_TAG_LABEL_CODE_POINTS = 1;

export const BUILT_IN_TRIGGERS: { id: string; label: string }[] = [
  { id: 'trigger-poor-sleep', label: 'Poor sleep' },
  { id: 'trigger-stress', label: 'Stress' },
  { id: 'trigger-illness', label: 'Illness' },
  { id: 'trigger-missed-medication', label: 'Missed medication' },
  { id: 'trigger-alcohol', label: 'Alcohol' },
  { id: 'trigger-flashing-lights', label: 'Flashing lights' },
  { id: 'trigger-dehydration', label: 'Dehydration' },
  { id: 'trigger-menstruation', label: 'Menstruation' },
];

export const BUILT_IN_AURAS: { id: string; label: string }[] = [
  { id: 'aura-unusual-smell', label: 'Unusual smell' },
  { id: 'aura-deja-vu', label: 'Déjà vu' },
  { id: 'aura-visual-changes', label: 'Visual changes' },
  { id: 'aura-tingling', label: 'Tingling' },
  { id: 'aura-dizziness', label: 'Dizziness' },
  { id: 'aura-nausea', label: 'Nausea' },
];

export function builtInTags(kind: TagKind): { id: string; label: string }[] {
  return kind === 'trigger' ? BUILT_IN_TRIGGERS : BUILT_IN_AURAS;
}

/**
 * Normalize a tag label per spec: NFKC, trim, collapse internal whitespace,
 * lowercase (locale-independent). Used for dedupe within an owner + kind.
 */
export function normalizeTagLabel(input: string): string {
  return input
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

export function codePointLength(input: string): number {
  return Array.from(input).length;
}

export function isValidTagLabel(label: string): boolean {
  const length = codePointLength(label.trim());
  return length >= MIN_TAG_LABEL_CODE_POINTS && length <= MAX_TAG_LABEL_CODE_POINTS;
}

export function trimText(input: string | undefined): string | undefined {
  if (input === undefined) return undefined;
  const trimmed = input.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
