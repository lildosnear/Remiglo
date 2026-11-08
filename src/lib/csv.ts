/**
 * Minimal RFC 4180 style CSV parsing for payout batch uploads.
 * Supports quoted fields, embedded commas and quotes ("" escapes),
 * and CRLF or LF line endings. No dependencies.
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ",") { pushField(); continue; }
    if (c === "\n") { pushRow(); continue; }
    if (c === "\r") continue;
    field += c;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  // Drop fully empty trailing lines.
  return rows.filter((r, idx) => !(idx === rows.length - 1 && r.every((f) => f.trim() === "")));
}

export interface CsvRowError { line: number; message: string }

export interface BatchCsvResult {
  rows?: Array<Record<string, unknown>>;
  errors: CsvRowError[];
}

const HEADER_ADDRESS = ["recipient_address", "destination_asset", "amount_units"];
const HEADER_RECIPIENT = ["recipient_id", "amount_units"];

/**
 * Parse a payout batch CSV. Accepted headers:
 *   recipient_address,destination_asset,amount_units[,reference]
 *   recipient_id,amount_units[,reference]
 * Every data row is validated; if any row is invalid, rows is undefined
 * and errors carries one entry per problem with its 1 based line number
 * (the header is line 1). Nothing is created from a partially valid file.
 */
export function parseBatchCsv(text: string): BatchCsvResult {
  const errors: CsvRowError[] = [];
  const table = parseCsv(text);
  if (table.length === 0) return { errors: [{ line: 1, message: "the file is empty" }] };
  const header = table[0].map((h) => h.trim().toLowerCase());
  const hasRef = header[header.length - 1] === "reference";
  const core = hasRef ? header.slice(0, -1) : header;
  const isAddress = JSON.stringify(core) === JSON.stringify(HEADER_ADDRESS);
  const isRecipient = JSON.stringify(core) === JSON.stringify(HEADER_RECIPIENT);
  if (!isAddress && !isRecipient) {
    return {
      errors: [{
        line: 1,
        message: `header must be "${HEADER_ADDRESS.join(",")}" or "${HEADER_RECIPIENT.join(",")}" (optionally followed by ",reference")`,
      }],
    };
  }
  const width = header.length;
  const dataRows = table.slice(1);
  if (dataRows.length === 0) return { errors: [{ line: 1, message: "the file has a header but no payout rows" }] };
  if (dataRows.length > 100) {
    return { errors: [{ line: 102, message: `a batch holds at most 100 rows, this file has ${dataRows.length}` }] };
  }
  const rows: Array<Record<string, unknown>> = [];
  dataRows.forEach((cells, idx) => {
    const line = idx + 2;
    if (cells.every((c) => c.trim() === "")) return; // skip blank lines
    if (cells.length !== width) {
      errors.push({ line, message: `expected ${width} fields, found ${cells.length}` });
      return;
    }
    const vals = cells.map((c) => c.trim());
    const amount = isAddress ? vals[2] : vals[1];
    if (!/^[0-9]+$/.test(amount) || BigInt(amount) <= 0n) {
      errors.push({ line, message: "amount_units must be a positive integer in smallest units" });
      return;
    }
    const reference = hasRef ? vals[width - 1] : "";
    if (isAddress) {
      if (!vals[0]) { errors.push({ line, message: "recipient_address is empty" }); return; }
      if (!vals[1]) { errors.push({ line, message: "destination_asset is empty" }); return; }
      rows.push({ recipientAddress: vals[0], destinationAsset: vals[1], amount, ...(reference ? { reference } : {}) });
    } else {
      if (!vals[0]) { errors.push({ line, message: "recipient_id is empty" }); return; }
      rows.push({ recipientId: vals[0], amount, ...(reference ? { reference } : {}) });
    }
  });
  if (errors.length > 0) return { errors };
  if (rows.length === 0) return { errors: [{ line: 1, message: "no payout rows found" }] };
  return { rows, errors: [] };
}
