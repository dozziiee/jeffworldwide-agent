// Demo VINs: correctly formed (WMI, model-year code, check digit) but clearly synthetic.
// Positions 12-17 are "JW" plus the car number, which no real manufacturer would issue.

const VALUES: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789"; // a 30-year cycle starting at 1980

/** Characters allowed in a VIN: no I, O or Q. */
export const VIN_ALPHABET = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789";

/** Model year -> the code in position 10: 2018 -> "J", 2021 -> "M", 2024 -> "R". */
export function modelYearCode(year: number): string {
  if (!Number.isInteger(year) || year < 1980) throw new Error(`No VIN year code for ${year}`);
  return YEAR_CODES[(year - 1980) % 30];
}

/** The check digit (position 9) for a 17-character VIN; whatever is in position 9 is ignored. */
export function checkDigit(vin: string): string {
  const sum = [...vin.toUpperCase()].reduce((total, char, i) => {
    const value = /\d/.test(char) ? Number(char) : VALUES[char];
    if (value === undefined) throw new Error(`"${char}" is not allowed in a VIN`);
    return total + value * WEIGHTS[i];
  }, 0);
  const remainder = sum % 11;
  return remainder === 10 ? "X" : String(remainder);
}

/** True for 17 allowed characters with a correct check digit. */
export function isValidVin(vin: string): boolean {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) && checkDigit(vin) === vin[8];
}

/** WMI (positions 1-3) for a make and model: who built it and where. */
export function wmiFor(make: string, model: string): string {
  const m = make.toLowerCase();
  const name = model.toLowerCase();
  if (m.includes("mercedes")) {
    if (name.startsWith("gle")) return "4JG"; // SUVs built in Alabama
    if (name.startsWith("glc") || name.startsWith("g ")) return "W1N"; // SUVs built in Germany and Austria
    return "W1K"; // saloons
  }
  if (m === "toyota") {
    if (name.includes("highlander")) return "5TD";
    if (name.includes("camry")) return "4T1";
    if (name.includes("corolla")) return "5YF";
    if (name.includes("fj")) return "JTE";
    return "JTD";
  }
  if (m === "lexus") return name.startsWith("es") ? "58A" : "JTJ";
  if (m === "cadillac") return "1GY";
  if (m === "porsche") return "WP1";
  if (m === "honda") {
    if (name.includes("cr-v")) return "2HK";
    if (name.includes("pilot")) return "5FN";
    return "1HG";
  }
  if (m === "lamborghini") return "ZPB";
  if (m === "tesla") return name.includes("cybertruck") ? "7G2" : "5YJ";
  throw new Error(`No WMI known for ${make} ${model}`);
}

/**
 * Builds a demo VIN.
 * descriptor: positions 4-8 (5 characters). plant: position 11. carNumber: 65 -> "JW0065" in positions 12-17.
 */
export function buildDemoVin(parts: { wmi: string; descriptor: string; year: number; plant: string; carNumber: number }): string {
  const serial = `JW${String(parts.carNumber).padStart(4, "0")}`;
  const draft = `${parts.wmi}${parts.descriptor}0${modelYearCode(parts.year)}${parts.plant}${serial}`.toUpperCase();
  if (draft.length !== 17) throw new Error(`VIN parts do not make 17 characters: ${draft}`);
  const vin = draft.slice(0, 8) + checkDigit(draft) + draft.slice(9);
  if (!isValidVin(vin)) throw new Error(`Built an invalid VIN: ${vin}`);
  return vin;
}
