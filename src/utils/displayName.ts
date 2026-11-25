export const DISPLAY_NAME_MAX_LENGTH = 50;

const LEADING_TRAILING_SPACES_RE = /^[ \u3000]+|[ \u3000]+$/g;
// Reject CR, LF, TAB, and any other ASCII C0/DEL control characters
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;

export function normalizeDisplayName(raw: string): string {
  return raw.replace(LEADING_TRAILING_SPACES_RE, '');
}

export function isDisplayNameEmpty(value: string | null | undefined): boolean {
  return normalizeDisplayName(value ?? '').length === 0;
}

export type DisplayNameValidationResult =
  | { valid: true; normalized: string }
  | { valid: false; error: string };

export function validateDisplayNameInput(raw: string): DisplayNameValidationResult {
  if (typeof raw !== 'string') {
    return { valid: false, error: '表示名を入力してください。' };
  }
  if (CONTROL_CHARS_RE.test(raw)) {
    return { valid: false, error: '改行やタブなどの制御文字は使用できません。' };
  }
  const normalized = normalizeDisplayName(raw);
  if (normalized.length === 0) {
    return { valid: false, error: '表示名を入力してください（空白のみは登録できません）。' };
  }
  if ([...normalized].length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      valid: false,
      error: `表示名は${DISPLAY_NAME_MAX_LENGTH}文字以内で入力してください。`,
    };
  }
  return { valid: true, normalized };
}
