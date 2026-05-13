/**
 * ID generation utility that works in both secure and non-secure contexts
 */
export function generateId(): string {
  // 1st choice: crypto.randomUUID() (HTTPS + localhost only)
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    try {
      return crypto.randomUUID();
    } catch {
      // fall through
    }
  }

  // 2nd choice: crypto.getRandomValues()
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    try {
      const array = new Uint8Array(16);
      crypto.getRandomValues(array);
      array[6] = (array[6] & 0x0f) | 0x40;
      array[8] = (array[8] & 0x3f) | 0x80;
      const hex = Array.from(array)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
      ].join("-");
    } catch {
      // fall through
    }
  }

  // 3rd choice: Math.random() fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
