type CsvValue = string | number | null;

export function toCsvRow(values: CsvValue[]): string {
  return values
    .map((value) => {
      if (value === null) return "";

      const raw = String(value);
      if (!/[",\r\n]/.test(raw)) return raw;

      return `"${raw.replace(/"/g, '""')}"`;
    })
    .join(",");
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return [toCsvRow(headers), ...rows.map(toCsvRow)].join("\r\n") + "\r\n";
}
