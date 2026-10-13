const LINK_PATTERN = /(?:https?:\/\/|\bwww\.|\bwa\.me\/|\bt\.me\/|\bbit\.ly\/|\btinyurl\.com\/|\bchat\.whatsapp\.com\/|\b(?:[a-z0-9-]+\.)+(?:com|net|org|edu|gov|pk|io|co|xyz|info|biz|app|dev|me|ly|gg|ai)(?:\/[^\s]*)?)/i;

const PROMOTION_PATTERN = /\b(?:buy\s+now|order\s+now|dm\s+me|inbox\s+me|contact\s+me|call\s+now|whatsapp\s+me|for\s+sale|limited\s+offer|special\s+offer|discounts?|promo(?:tion)?(?:\s+code)?|marketing\s+services|price\s+list|earn\s+money|investment\s+plan|click\s+here|subscribe\s+now|delivery\s+available|available\s+for\s+order|order\s+(?:karein|karen|kro|karo)|rabta\s+(?:karein|karen|kro|karo)|contact\s+(?:karein|karen|kro|karo)|whatsapp\s+(?:karein|karen|kro|karo)|dm\s+(?:karein|karen|kro|karo)|inbox\s+(?:karein|karen|kro|karo)|khareed(?:ain|en|o)|qeemat(?:ain)?|rate\s+list|kamai\s+karein|paise\s+kamayein|online\s+earning|special\s+discount)\b/i;

export function hasUrlLikeContent(value = '') {
  return LINK_PATTERN.test(String(value));
}

export function hasBusinessPromotion(value = '') {
  return PROMOTION_PATTERN.test(String(value));
}

export function isGroupAdmin(meta, jid) {
  if (!meta || !Array.isArray(meta.participants) || !jid) return false;
  return meta.participants.some(p => p.id === jid && (p.admin === 'admin' || p.admin === 'superadmin'));
}

export function getAdminVerification(meta, jid) {
  if (!meta || !Array.isArray(meta.participants)) return 'unknown';
  return isGroupAdmin(meta, jid) ? 'verified_admin' : 'not_admin';
}
