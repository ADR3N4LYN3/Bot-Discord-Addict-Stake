import { extractCodeFromUrl, inferBonusRecord } from '../lib/parser.js';

const url = process.argv[2] || 'https://playstake.club/bonus?code=augustpostmonthly210823jasd93';
const code = extractCodeFromUrl(url);
const rec = inferBonusRecord({ url, code });

console.log(JSON.stringify({
  url,
  code,
  detectedKind: rec?.kind || 'unknown'
}, null, 2));
