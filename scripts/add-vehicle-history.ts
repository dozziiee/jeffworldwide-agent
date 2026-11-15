// One-off script: adds demo VINs and illustrative history columns to the Inventory tab.
// It only writes the four columns vin, title_status, owners and accidents_reported.
// The random seed is fixed, so running it again writes the same values.
//
//   npm run add-vehicle-history              write the columns
//   npm run add-vehicle-history -- --dry-run print what would be written

import { loadSheet, sheetsRequest } from "../src/sheets";
import { buildDemoVin, VIN_ALPHABET, wmiFor } from "../src/vin";

const SEED = 20261115;
const COLUMNS = ["vin", "title_status", "owners", "accidents_reported"];
const ACCIDENT_COUNT = 15; // of 100 cars; the rest are "None reported"
const ACCIDENTS = ["1 minor (rear bumper, repaired)", "1 minor (front bumper, repaired)"];

/** Small seeded random number generator (mulberry32): same seed, same sequence. */
function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const columnLetter = (index: number) => {
  let letters = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return letters;
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const sheet = await loadSheet();
  const cars = [...sheet.cars].sort((a, b) => a.row - b.row);
  const random = seededRandom(SEED);
  const pick = (chars: string) => chars[Math.floor(random() * chars.length)];

  // Positions 4-8 and the plant letter are the same for every car of one model, as on real cars.
  const perModel = new Map<string, { descriptor: string; plant: string }>();
  for (const car of cars) {
    const key = `${car.make}|${car.model}`;
    if (!perModel.has(key)) {
      perModel.set(key, { descriptor: Array.from({ length: 5 }, () => pick(VIN_ALPHABET)).join(""), plant: pick("ABCDEFGHJKLMNPRSTUVWXYZ") });
    }
  }

  // Exactly ACCIDENT_COUNT cars get a minor accident, chosen by a seeded shuffle.
  const shuffled = cars.map((car) => car.car_id);
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const withAccident = new Set(shuffled.slice(0, Math.round((ACCIDENT_COUNT / 100) * cars.length)));

  const values = new Map<number, (string | number)[]>(); // sheet row -> the four cells
  for (const car of cars) {
    const carNumber = Number(car.car_id.match(/(\d+)\D*$/)?.[1]);
    if (!Number.isInteger(carNumber)) throw new Error(`Cannot read a car number from ${car.car_id}`);
    const vin = buildDemoVin({ wmi: wmiFor(car.make, car.model), ...perModel.get(`${car.make}|${car.model}`)!, year: car.year, carNumber });
    const roll = random();
    const owners = roll < 0.5 ? 1 : roll < 0.88 ? 2 : 3; // weighted towards 1 and 2
    const accident = withAccident.has(car.car_id) ? ACCIDENTS[Math.floor(random() * ACCIDENTS.length)] : "None reported";
    values.set(car.row, [vin, "Clean", owners, accident]);
  }

  const rows = [...values.values()];
  const count = (test: (row: (string | number)[]) => boolean) => rows.filter(test).length;
  console.log(`${cars.length} cars`);
  console.log(`owners: 1 -> ${count((r) => r[2] === 1)}, 2 -> ${count((r) => r[2] === 2)}, 3 -> ${count((r) => r[2] === 3)}`);
  console.log(`accidents: none -> ${count((r) => r[3] === "None reported")}, rear -> ${count((r) => r[3] === ACCIDENTS[0])}, front -> ${count((r) => r[3] === ACCIDENTS[1])}`);
  console.log(`unique VINs: ${new Set(rows.map((r) => r[0])).size}`);
  for (const car of cars.slice(0, 5)) console.log(`  ${car.car_id} ${car.year} ${car.make} ${car.model}: ${values.get(car.row)!.join(" | ")}`);

  if (dryRun) {
    console.log("\nDry run: nothing written.");
    return;
  }

  // Add any missing columns after the last existing one, growing the grid if it is full.
  const columns = { ...sheet.columns };
  const missing = COLUMNS.filter((name) => !(name in columns));
  if (missing.length) {
    const meta = await sheetsRequest("?fields=sheets.properties(title,sheetId,gridProperties.columnCount)");
    const tab = meta.sheets.find((s: any) => String(s.properties.title).toLowerCase() === "inventory").properties;
    let next = Math.max(...Object.values(columns)) + 1;
    const needed = next + missing.length - tab.gridProperties.columnCount;
    if (needed > 0) {
      await sheetsRequest(":batchUpdate", {
        method: "POST",
        body: JSON.stringify({ requests: [{ appendDimension: { sheetId: tab.sheetId, dimension: "COLUMNS", length: needed } }] }),
      });
    }
    for (const name of missing) columns[name] = next++;
  }

  // One range per column: the header, then each car's value on its own row.
  const lastRow = Math.max(...values.keys());
  const data = COLUMNS.map((name, i) => {
    const letter = columnLetter(columns[name]);
    const cells: (string | number)[][] = [[name]];
    for (let row = 2; row <= lastRow; row++) cells.push([values.get(row)?.[i] ?? ""]);
    return { range: `Inventory!${letter}1:${letter}${lastRow}`, values: cells };
  });
  await sheetsRequest("values:batchUpdate", { method: "POST", body: JSON.stringify({ valueInputOption: "RAW", data }) });
  console.log(`\nWrote ${COLUMNS.join(", ")} for ${cars.length} cars (columns ${COLUMNS.map((n) => columnLetter(columns[n])).join(", ")}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
