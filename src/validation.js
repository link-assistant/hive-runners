export function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function integer(value, min, max, label) {
  requireValue(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `${label} must be between ${min} and ${max}`
  );
  return value;
}
