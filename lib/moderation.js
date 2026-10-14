const LINK_PATTERN = /(?:https?:\/\/|hxxps?:\/\/|\bwww\.|\bwa\.me\/|\bt\.me\/|\bbit\.ly\/|\btinyurl\.com\/|\bchat\.whatsapp\.com\/|\b(?:[a-z0-9-]+\.)+(?:com|net|org|edu|gov|pk|io|co|xyz|info|biz|app|dev|me|ly|gg|ai|site|online|store|shop|top|live|cloud|tech|pro)(?:\/[^\s]*)?)/i;
const OBFUSCATED_DOMAIN = /\b[a-z0-9-]{2,}\s*(?:\[?\s*dot\s*\]?|\(\s*dot\s*\)|\{\s*dot\s*\}|\[\.\])\s*(?:com|net|org|edu|gov|pk|io|co|xyz|info|biz|app|dev|me|ly|gg|ai|site|online|store|shop|top|live|cloud|tech|pro)\b/i;

const PROMOTION_PATTERN = /\b(?:buy\s+now|order\s+now|dm\s+me|inbox\s+me|contact\s+me|call\s+now|whatsapp\s+me|for\s+sale|limited\s+offer|special\s+offer|discounts?|promo(?:tion)?(?:\s+code)?|marketing\s+services|price\s+list|earn\s+money|investment\s+plan|click\s+here|subscribe\s+now|delivery\s+available|available\s+for\s+order|order\s+(?:karein|karen|kro|karo)|rabta\s+(?:karein|karen|kro|karo)|contact\s+(?:karein|karen|kro|karo)|whatsapp\s+(?:karein|karen|kro|karo)|dm\s+(?:karein|karen|kro|karo)|inbox\s+(?:karein|karen|kro|karo)|khareed(?:ain|en|o)|qeemat(?:ain)?|rate\s+list|kamai\s+karein|paise\s+kamayein|online\s+earning|special\s+discount|business\s+promotion|join\s+my\s+group|message\s+me\s+privately|paid\s+service|free\s+gift|crypto\s+signal|investment\s+return|join\s+now|link\s+in\s+bio|dm\s+for\s+details|earn\s+from\s+home|ghar\s+bethe\s+kamayein|job\s+vacanc(?:y|ies)|admission\s+open|affiliate\s+link|referral\s+bonus|sell\s+now|available\s+for\s+sale)\b/i;

const OBSCENE_TERMS = [[120,120,120],[101,120,112,108,105,99,105,116],[97,100,117,108,116],[112,111,114,110],[112,111,114,110,111],[112,111,114,110,111,103,114,97,112,104,121],[104,101,110,116,97,105],[110,117,100,101],[110,117,100,101,115],[110,97,107,101,100],[110,115,102,119],[111,110,108,121,102,97,110,115],[115,101,120],[115,101,120,121],[115,101,120,117,97,108],[104,111,114,110,121],[101,114,111,116,105,99],[98,108,111,119,106,111,98],[104,97,110,100,106,111,98],[99,117,109],[111,114,103,97,115,109],[109,97,115,116,117,114,98,97,116,105,111,110],[109,97,115,116,117,114,98,97,116,101],[112,101,110,105,115],[118,97,103,105,110,97],[100,105,99,107],[112,117,115,115,121],[98,111,111,98,115],[116,105,116,115],[102,117,99,107],[102,117,99,107,105,110,103],[102,117,99,107,101,100],[109,111,116,104,101,114,102,117,99,107,101,114],[115,104,105,116],[98,105,116,99,104],[98,97,115,116,97,114,100],[115,108,117,116],[119,104,111,114,101],[97,115,115,104,111,108,101],[99,104,117,116],[99,104,111,111,116],[99,104,117,116,105,121,97],[108,117,110,100],[103,97,97,110,100],[103,97,110,100],[114,97,110,100,105],[98,104,111,115,100,105],[98,104,111,115,100,105,107,101],[109,97,100,97,114,99,104,111,100],[98,101,104,101,110,99,104,111,100],[104,97,114,97,109,105],[107,117,116,105,121,97],[103,97,110,100,117],[102,117,100,100,105],[112,104,117,100,100,105],[103,97,97,110,100,117,117],[112,111,114,110,104,117,98],[120,118,105,100,101,111,115],[120,110,120,120],[120,120,120,118,105,100,101,111],[115,101,120,118,105,100,101,111]].map(codes => String.fromCharCode(...codes));

const META_KEYS = new Set(['messageContextInfo','senderKeyDistributionMessage','messageSecretMessage','protocolMessage']);
const WRAPPER_KEYS = ['ephemeralMessage','viewOnceMessage','viewOnceMessageV2','viewOnceMessageV2Extension','documentWithCaptionMessage','editedMessage','deviceSentMessage','groupMentionedMessage'];

export function normalizeModerationText(value = '') {
  return String(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200B-\u200F\uFEFF]/g, '')
    .toLowerCase()
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[013457@$]/g, c => ({'0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','@':'a','$':'s'}[c] || c))
    .replace(/[^ \p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function hasUrlLikeContent(value = '') {
  const raw = String(value).replace(/[\u200B-\u200F\uFEFF]/g, '').replace(/[。．｡]/g, '.');
  const normalized = normalizeModerationText(raw);
  return LINK_PATTERN.test(raw) || OBFUSCATED_DOMAIN.test(raw) ||
    /\b(?:h\s*t\s*t\s*p\s*s?|w\s*w\s*w)\b/i.test(normalized) ||
    /\b[a-z0-9-]{2,}\s+dot\s+(?:com|net|org|edu|gov|pk|io|co|xyz|info|biz|app|dev|me|ly|gg|ai|site|online|store|shop|top|live|cloud|tech|pro)\b/i.test(normalized);
}

export function hasBusinessPromotion(value = '') {
  const raw = String(value);
  const normalized = normalizeModerationText(raw);
  const compact = normalized.replace(/\s+/g, '');
  const compactPhrases = [
    'buynow','ordernow','dmme','inboxme','contactme','callnow','whatsappme','forsale',
    'limitedoffer','specialoffer','pricelist','earnmoney','investmentplan','clickhere',
    'subscribenow','deliveryavailable','onlineearning','businesspromotion','joinmygroup',
    'paidservice','freegift','cryptosignal','joinnow','linkinbio','dmfordetails',
    'earnfromhome','gharbethekamayein','jobvacancy','jobvacancies','admissionopen',
    'affiliatelink','referralbonus','sellnow','availableforsale'
  ];
  return PROMOTION_PATTERN.test(raw) || PROMOTION_PATTERN.test(normalized) || compactPhrases.some(phrase => compact.includes(phrase));
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
    if (!term) return false;
    const pattern = term.split(' ').join('\\s+');
    return new RegExp('(^|\\s)' + pattern + '(?=\\s|$)', 'iu').test(normalized);
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
  const { textOnly = true, blockPhoneNumbers = true, blockBusinessPromo = true, blockAdultWords = true } = options;
  const content = unwrapMessageContent(message);
  const contentKeys = Object.keys(content).filter(key => content[key] != null && !META_KEYS.has(key));
  const hasNonText = contentKeys.some(key => !['conversation','extendedTextMessage'].includes(key));
  const text = String(getMessageText(message) || '').trim();
  const context = content.extendedTextMessage?.contextInfo || {};
  const ad = context.externalAdReply || {};
  const hiddenLinkText = [ad.sourceUrl, ad.matchedText, ad.canonicalUrl, ad.title, ad.body].filter(x => typeof x === 'string').join(' ');
  const linkContext = [context.quotedMessage?.conversation, context.quotedMessage?.extendedTextMessage?.text].filter(x => typeof x === 'string').join(' ');
  const hasLink = hasUrlLikeContent(text) || hasUrlLikeContent(hiddenLinkText) || hasUrlLikeContent(linkContext);
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
    const participantIds = normalizedJids([p.id,p.phoneNumber,p.lid]);
    const matches = [...participantIds].some(id => candidates.has(id));
    return matches && (p.admin === 'admin' || p.admin === 'superadmin');
  });
}

export function getAdminVerification(meta, jid) {
  if (!meta || !Array.isArray(meta.participants)) return 'unknown';
  return isGroupAdmin(meta, jid) ? 'verified_admin' : 'not_admin';
}
