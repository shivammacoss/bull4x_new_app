// Currency display helpers. The backend stores and returns an INR trading
// account's balance / equity / margin / P&L already converted to INR, so the
// app only needs to render the correct symbol (₹ vs $) per account currency.

export function currencySymbol(currency) {
  return String(currency || 'USD').toUpperCase() === 'INR' ? '₹' : '$';
}

export function currencyCode(currency) {
  return String(currency || 'USD').toUpperCase();
}

/**
 * Format an amount with the account's currency symbol.
 * fmtMoney(1886.61, 'INR') -> "₹1,886.61"
 * fmtMoney(-50, 'USD')     -> "-$50.00"
 */
export function fmtMoney(amount, currency = 'USD', fractionDigits = 2) {
  const n = Number(amount);
  const safe = Number.isFinite(n) ? n : 0;
  const sym = currencySymbol(currency);
  const abs = Math.abs(safe).toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
  return `${safe < 0 ? '-' : ''}${sym}${abs}`;
}

/**
 * Signed format for P&L (always shows + or -).
 * fmtSigned(45.2, 'INR') -> "+₹45.20"
 */
export function fmtSigned(amount, currency = 'USD', fractionDigits = 2) {
  const n = Number(amount);
  const safe = Number.isFinite(n) ? n : 0;
  return `${safe >= 0 ? '+' : ''}${fmtMoney(safe, currency, fractionDigits)}`;
}
