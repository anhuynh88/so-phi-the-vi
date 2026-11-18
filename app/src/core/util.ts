export const now = () => new Date().toISOString();

export function rid(prefix = ""): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return prefix + Date.now().toString(36) + Array.from(b, (x) => x.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

export function hex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(s: string): Uint8Array {
  const clean = s.trim();
  if (!/^([0-9a-fA-F]{2})+$/.test(clean)) throw new Error("bad hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

export function b64(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** So sánh chuỗi không lộ thời gian (cho token, mật khẩu, chữ ký). */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a), eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

export const yymm = (k: string) => { const m = /^(\d{4})-(\d{2})$/.exec(k); return m ? m[1].slice(2) + m[2] : ""; };
export const isMonth = (k: unknown): k is string => typeof k === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(k);

export const EXT_CT: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  xls: "application/vnd.ms-excel",
  csv: "text/csv", md: "text/markdown", markdown: "text/markdown", txt: "text/plain",
  zip: "application/zip", pdf: "application/pdf", json: "application/json", eml: "message/rfc822",
};
export const extOf = (name: string) => { const m = /\.([^.]+)$/.exec(name || ""); return m ? m[1].toLowerCase() : ""; };
export const OK_EXT = /\.(xlsx|xlsm|xls|csv|md|markdown|txt)$/i;

/** Danh sách thư mục acquirer, khớp ACQ trong trang (id thư mục). */
export const KNOWN_ACQ: Record<string, string[]> = {
  ECOM: ["adyen", "2c2p", "paypal", "amex-ecom", "vcb", "vnpay", "napas", "shopeepay", "vietqr-mb", "momo", "kcp", "ecom-khac"],
  BSP: ["worldpay", "amex-bsp", "accelya", "payone", "jcb-jp", "uc-card-jp", "bsp-khac"],
  "BANK STATEMENT": [""],
  "TONG HOP": [""],
};
export function validPlace(sec: string, acq: string): boolean {
  return (KNOWN_ACQ[sec] || []).includes(acq);
}

export function csvCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return isFinite(v) ? String(v) : "";
  const s = String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s; // chặn công thức khi mở bằng Excel
  return /[",\n\r]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
}

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string) { super(message || code); }
}
