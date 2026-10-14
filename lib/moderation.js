const LINK_PATTERN = /(?:https?:\/\/|\bwww\.|\bwa\.me\/|\bt\.me\/|\bbit\.ly\/|\btinyurl\.com\/|\bchat\.whatsapp\.com\/|\b(?:[a-z0-9-]+\.)+(?:com|net|org|edu|gov|pk|io|co|xyz|info|biz|app|dev|me|ly|gg|ai)(?:\/[^\s]*)?)/i;

const PROMOTION_PATTERN = /\b(?:buy\s+now|order\s+now|dm\s+me|inbox\s+me|contact\s+me|call\s+now|whatsapp\s+me|for\s+sale|limited\s+offer|special\s+offer|discounts?|promo(?:tion)?(?:\s+code)?|marketing\s+services|price\s+list|earn\s+money|investment\s+plan|click\s+here|subscribe\s+now|delivery\s+available|available\s+for\s+order|order\s+(?:karein|karen|kro|karo)|rabta\s+(?:karein|karen|kro|karo)|contact\s+(?:karein|karen|kro|karo)|whatsapp\s+(?:karein|karen|kro|karo)|dm\s+(?:karein|karen|kro|karo)|inbox\s+(?:karein|karen|kro|karo)|khareed(?:ain|en|o)|qeemat(?:ain)?|rate\s+list|kamai\s+karein|paise\s+kamayein|online\s+earning|special\s+discount|business\s+promotion|join\s+my\s+group|message\s+me\s+privately|paid\s+service|free\s+gift|crypto\s+signal|investment\s+return)\b/i;

const OBSCENE_TERMS = [
  'xxx','porn','porno','pornography','hentai','nude','nudes','naked','nsfw',
  'onlyfans','sex','sexy','sexual','horny','erotic','blowjob','handjob',
  'masturbation','masturbate','penis','vagina','dick','pussy','boobs','tits',
  'fuck','fucking','fucked','motherfucker','shit','bitch','bastard','slut',
  'whore','asshole','chut','choot','chutiya','lund','gaand','gand','randi',
  'bhosdi','bhosdike','madarchod','behenchod','harami','kutiya','gandu',
  'fuddi','phuddi','gaanduu','pornhub','xvideos','xnxx'
];

const META_KEYS = new Set([
  'messageContextInfo',
  'senderKeyDistributionMessage',
  'messageSecretMessage',
  'protocolMessage'
]);
const WRAPPER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
  'editedMessage',
  'deviceSentMessage',
  'groupMentionedMessage'
];

export function normalizeModerationText(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .toLowerCase()
    .replace(/[013457@$]/g, c => ({'0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','@':'a','$':'s'}[c] || c))
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function hasUrlLikeContent(value = '') {
  return LINK_PATTERN.test(String(value));
}

export function hasBusinessPromotion(value = '') {
  return PROMOTION_PATTERN.test(String(value));
}

export function hasObsceneContent(value = '') {
  const normalized = normalizeModerationText(value);
  if (!normalized) return false;
  return OBSCENE_TERMS.some(term => {
    const pattern = term.split('').join('[^\\p{L}\\p{N}]*');
    return new RegExp('(^|[^\\p{L}\\p{N}])' + pattern + '($|[^\\p{L}\\p{N}])', 'iu').test(normalized);
  });
}

export function hasBlockedWordContent(value = '', words = []) {
  const normalized = ' ' + normalizeModerationText(value) + ' ';
  if (!normalized.trim()) return false;
  return (Array.isArray(words) ? words : []).some(word => {
    const term = normalizeModerationText(word);
    return term.length > 0 && normalized.includes(' ' + term + ' ');
  });
}

export function unwrapMessageContent(message = {}) {
  let current = message && typeof message === 'object' ? message : {};
  for (let depth = 0; depth < 8; depth++) {
    const wrapper = WRAPPER_KEYS.find(key => current[key]?.message && typeof current[key].message === 'object');
    if (!wrapper) break;
    current = current[wrapper].message;
  }
  return current;
}

export function getMessageText(message = {}) {
  const content = unwrapMessageContent(message);
  return content.conversation
    || content.extendedTextMessage?.text
    || content.imageMessage?.caption
    || content.videoMessage?.caption
    || content.documentMessage?.caption
    || content.buttonsResponseMessage?.selectedButtonId
    || content.listResponseMessage?.singleSelectReply?.selectedRowId
    || content.templateButtonReplyMessage?.selectedId
    || content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
    || '';
}

export function getMessageModerationViolation(message = {}, options = {}) {
  const {
    textOnly = true,
    blockPhoneNumbers = true,
    blockBusinessPromo = true,
    blockAdultWords = true
  } = options;
  const content = unwrapMessageContent(message);
  const contentKeys = Object.keys(content).filter(key => content[key] != null && !META_KEYS.has(key));
  const hasNonText = contentKeys.some(key => !['conversation', 'extendedTextMessage'].includes(key));
  const text = String(getMessageText(message) || '').trim();
  const context = content.extendedTextMessage?.contextInfo || {};
  const ad = context.externalAdReply || {};
  const hiddenLinkText = [ad.sourceUrl, ad.matchedText, ad.canonicalUrl].filter(x => typeof x === 'string').join(' ');
  const hasLink = hasUrlLikeContent(text) || hasUrlLikeContent(hiddenLinkText);
  const hasPhone = blockPhoneNumbers && /(?:\+?\d[\d .()\-]{7,}\d)/.test(text);
  const hasPromo = blockBusinessPromo && hasBusinessPromotion(text);
  const hasAdultWords = blockAdultWords && hasObsceneContent(text);
  let reason = '';
  if (textOnly && hasNonText) reason = 'non-text content';
  else if (hasAdultWords) reason = 'obscene or adult language';
  else if (hasLink) reason = 'link';
  else if (hasPhone) reason = 'phone number';
  else if (hasPromo) reason = 'business promotion';
  return reason ? { reason, text, hasNonText, hasAdultWords, hasLink, hasPhone, hasPromo } : null;
}

function normalizedJids(values) {
  const list = Array.isArray(values) ? values : [values];
  return new Set(list.filter(value => typeof value === 'string').flatMap(value => {
    const raw = value.trim();
    if (!raw) return [];
    const normalized = raw.includes('@') ? raw.replace(/:\d+(?=@)/, '') : raw;
    return [raw, normalized];
  }));
}

export function isGroupAdmin(meta, jid) {
  if (!meta || !Array.isArray(meta.participants) || !jid) return false;
  const candidates = normalizedJids(jid);
  return meta.participants.some(p => {
    const participantIds = normalizedJids([p.id, p.phoneNumber, p.lid]);
    const matches = [...participantIds].some(id => candidates.has(id));
    return matches && (p.admin === 'admin' || p.admin === 'superadmin');
  });
}

export function getAdminVerification(meta, jid) {
  if (!meta || !Array.isArray(meta.participants)) return 'unknown';
  return isGroupAdmin(meta, jid) ? 'verified_admin' : 'not_admin';
}
