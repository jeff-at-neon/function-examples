/**
 * RFC 4180 CSV parsing and writing. Pure, and the block's main seam: naive `split(",")` corrupts
 * any file with a quoted comma, which is most real files. Handles quoted fields, embedded commas
 * and newlines, escaped `""`, and both CRLF and LF line endings, without adding a phantom row for a
 * trailing newline.
 */

/** Parse CSV text into rows of string fields. A trailing newline does not produce an empty row. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let sawContent = false; // did the current record have any field or delimiter yet?
  let i = 0;

  const endRecord = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
    sawContent = false;
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      sawContent = true;
      i++;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      sawContent = true;
      i++;
    } else if (ch === "\r") {
      endRecord();
      i += text[i + 1] === "\n" ? 2 : 1;
    } else if (ch === "\n") {
      endRecord();
      i++;
    } else {
      field += ch;
      sawContent = true;
      i++;
    }
  }

  // Flush a final record only if it actually held content — a trailing newline leaves nothing.
  if (sawContent || field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Quote a single field for CSV output when it contains a comma, quote, or newline. */
export function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Serialize rows to RFC 4180 CSV text (CRLF line endings), re-escaping every field. */
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
}
