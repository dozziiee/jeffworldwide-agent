// One-off script: finds a freely licensed photo on Wikimedia Commons for each make + model
// in the Inventory tab and writes the picks to the Photos tab. Not part of the server.
//
//   npm run fetch-photos              search, pick, and write the Photos tab
//   npm run fetch-photos -- --dry-run search and print the picks without writing
//
// The picks are automatic, so check the printed table and fix any wrong ones in the sheet by hand.

import { normalise } from "../src/search";
import { loadSheet, PHOTO_HEADERS, replaceTab } from "../src/sheets";

const API = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT = "inventory-photo-fetch/1.0 (one-off script)";
const WIDTH = 1280;

// Only these licences are accepted: CC BY, CC BY-SA, CC0 / public domain.
const LICENCE_OK = /^(CC BY(-SA)? \d(\.\d)?( [a-z-]+)?|CC0( 1\.0)?|Public domain|PD([ -].*)?)$/i;

// Words in a file name that suggest the photo is not a plain exterior shot of a road car.
const BAD_WORDS =
  /\b(interior|interieur|innenraum|cockpit|dashboard|engine|motor|wheel|felge|logo|badge|emblem|detail|seat|steering|trunk|kofferraum|crash|accident|wreck|police|polizei|taxi|concept|prototype|toy|lego|drawing|render|rendering|race|racing|rally|brabus|mansory|lumma|hamann|novitec|cutaway|chassis|key|screen|display|charging|sketch|patent)\b/i;
const REAR_WORDS = /\b(rear|heck|hinten|back)\b/i;
// Body styles and spin-off models: "Corolla Cross" is not a Corolla, a "Cayenne Coupe" is not a Cayenne.
const VARIANT_WORDS = ["cross", "coupe", "cabrio", "cabriolet", "convertible", "hatchback", "estate", "limousine"];
// Photo dates in file names ("2023-06-04", "06-04-2023", "6.16.19") are not model years.
const DATES = /\b(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2}-\d{4}|\d{1,2}\.\d{1,2}\.\d{2,4})\b/g;
const YEARS = /\b(19[89]\d|20[0-3]\d)\b/g;

/** "Coupé" -> "Coupe", so accented names still match. */
const fold = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

type Candidate = {
  title: string;
  pageUrl: string;
  photoUrl: string;
  author: string;
  licence: string;
  score: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stripHtml = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Original file URL -> direct 1280px thumbnail on upload.wikimedia.org. */
function thumbUrl(originalUrl: string, width: number): string {
  // The API appends tracking parameters ("?utm_source=..."); drop them first.
  const match = originalUrl.split("?")[0].match(/^(https:\/\/upload\.wikimedia\.org\/wikipedia\/commons)\/(\w\/\w\w)\/([^/]+)$/);
  if (!match) return "";
  return `${match[1]}/thumb/${match[2]}/${match[3]}/${width}px-${match[3]}`;
}

/** Fetch with a pause before each request, and a wait-and-retry when Wikimedia says "too many requests". */
async function politeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    await sleep(1000);
    const res = await fetch(url, { ...init, headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (res.status !== 429 || attempt === 4) return res;
    const wait = Number(res.headers.get("retry-after")) || 30 * attempt;
    console.warn(`  rate limited, waiting ${wait}s...`);
    await sleep(wait * 1000);
  }
}

async function search(query: string): Promise<any[]> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: "6",
    gsrlimit: "30",
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiextmetadatafilter: "LicenseShortName|Artist|ImageDescription|Categories",
  });
  const res = await politeFetch(`${API}?${params}`);
  if (!res.ok) throw new Error(`Commons API returned HTTP ${res.status}`);
  const body: any = await res.json();
  return Object.values(body.query?.pages ?? {});
}

/** Scores one search result for a model; returns null if it must not be used. */
function assess(page: any, modelText: string, years: number[]): Candidate | null {
  const info = page.imageinfo?.[0];
  const meta = info?.extmetadata ?? {};
  const licence = String(meta.LicenseShortName?.value ?? "").trim();
  if (!info || !LICENCE_OK.test(licence)) return null;
  if (info.mime !== "image/jpeg" || info.width < WIDTH) return null;
  const ratio = info.width / info.height;
  if (ratio < 1.2 || ratio > 2.3) return null; // landscape only

  const title = fold(String(page.title).replace(/^File:/, "").replace(/\.\w+$/, ""));
  const titleText = ` ${normalise(title)} `;
  const allText = ` ${titleText} ${normalise(meta.Categories?.value)} ${normalise(stripHtml(String(meta.ImageDescription?.value ?? "")))} `;
  const tokens = modelText.split(" ");
  if (!tokens.every((token) => allText.includes(` ${token} `) || allText.includes(token))) return null;
  if (BAD_WORDS.test(title) || /interiors?\b/i.test(String(meta.Categories?.value ?? ""))) return null;
  if (VARIANT_WORDS.some((word) => titleText.includes(` ${word} `) && !` ${modelText} `.includes(` ${word} `))) return null;

  let score = 0;
  if (titleText.includes(` ${modelText} `)) score += 5; // the file name names this exact model
  else if (tokens.every((token) => titleText.includes(token))) score += 2;
  if (/\bfront\b/i.test(title)) score += 1;
  if (REAR_WORDS.test(title)) score -= 3;

  // Generation. A year in the file name is treated as the model year: it must be close to the
  // inventory's years, or the photo is rejected. Years elsewhere in the page are only a weak hint.
  const [min, max] = [Math.min(...years), Math.max(...years)];
  const titleYears = [...title.replace(DATES, " ").matchAll(YEARS)].map((m) => Number(m[1]));
  if (titleYears.length) {
    if (titleYears.some((y) => years.includes(y))) score += 5;
    else if (titleYears.some((y) => y >= min - 1 && y <= max + 1)) score += 3;
    else return null;
  } else if ([...allText.replace(DATES, " ").matchAll(YEARS)].some((m) => years.includes(Number(m[1])))) {
    score += 1;
  }

  score -= (page.index ?? 30) * 0.05; // keep Commons' own ranking as a tie-breaker

  const photoUrl = thumbUrl(String(info.url), WIDTH);
  if (!photoUrl) return null;
  return {
    title,
    pageUrl: String(info.descriptionurl).split("?")[0],
    photoUrl,
    author: stripHtml(String(meta.Artist?.value ?? "")).slice(0, 80) || "Unknown author",
    licence,
    score,
  };
}

async function imageExists(url: string): Promise<boolean> {
  try {
    const res = await politeFetch(url, { method: "HEAD" });
    return res.ok && String(res.headers.get("content-type")).startsWith("image/");
  } catch {
    return false;
  }
}

async function pickPhoto(make: string, model: string, years: number[]): Promise<Candidate | null> {
  // "S-Class S 580" is filed on Commons as "S 580".
  const searchModel = model.replace(/\b[A-Z]-Class\b/i, "").trim();
  const modelText = normalise(searchModel);
  const queries = [...years.map((year) => `${make} ${searchModel} ${year}`), `${make} ${searchModel}`];

  const best = new Map<string, Candidate>();
  for (const query of queries) {
    for (const page of await search(query)) {
      const candidate = assess(page, modelText, years);
      if (candidate && candidate.score > (best.get(candidate.title)?.score ?? -Infinity)) best.set(candidate.title, candidate);
    }
  }

  for (const candidate of [...best.values()].sort((a, b) => b.score - a.score).slice(0, 5)) {
    if (candidate.score < 2) break; // too weak a match to trust
    if (await imageExists(candidate.photoUrl)) return candidate;
  }
  return null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { cars } = await loadSheet();

  const models = new Map<string, { make: string; model: string; years: Set<number> }>();
  for (const car of cars) {
    const key = `${car.make}|${car.model}`;
    if (!models.has(key)) models.set(key, { make: car.make, model: car.model, years: new Set() });
    models.get(key)!.years.add(car.year);
  }
  console.log(`${models.size} distinct make + model pairs in Inventory\n`);

  const rows: string[][] = [];
  const missing: string[] = [];
  for (const { make, model, years } of models.values()) {
    let pick: Candidate | null = null;
    try {
      pick = await pickPhoto(make, model, [...years].sort());
    } catch (err) {
      console.warn(`  ! ${make} ${model}: ${err instanceof Error ? err.message : err}`);
    }
    if (pick) {
      rows.push([make, model, pick.photoUrl, pick.pageUrl, pick.author, pick.licence]);
      console.log(`${make} ${model} [${[...years].sort().join(", ")}]\n    ${pick.title}\n    ${pick.author} | ${pick.licence} | score ${pick.score.toFixed(1)}\n    ${pick.pageUrl}`);
    } else {
      rows.push([make, model, "", "", "", ""]);
      missing.push(`${make} ${model}`);
      console.log(`${make} ${model} [${[...years].sort().join(", ")}]\n    (nothing suitable found)`);
    }
  }

  if (dryRun) console.log("\nDry run: Photos tab not written.");
  else {
    await replaceTab("Photos", PHOTO_HEADERS, rows);
    console.log(`\nWrote ${rows.length} rows to the Photos tab.`);
  }
  console.log(missing.length ? `\nNo photo found for: ${missing.join("; ")}` : "\nEvery model has a photo.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
