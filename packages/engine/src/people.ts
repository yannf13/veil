/**
 * Names and postal addresses, found offline with a first-name lexicon, structure and context.
 *
 * A single word is never treated as a name on the lexicon alone: too many first names are also
 * words, places or software. A name needs one of:
 *  - a known first name followed by a surname ("Jane Doe", "Marie-Claire de la Tour", "DUPONT Jean"),
 *  - a title ("Mr Smith", "Mme Dupont", "Herr Müller", "Dr. Okafor"),
 *  - context: a greeting ("Hi Kofi,"), a sign-off on its own line, "my name is" / "je m'appelle" /
 *    "ich heiße", or a form label ("Name:", "Nom :").
 */
import { AMBIGUOUS_FIRST_NAMES_PACKED, FIRST_NAMES_PACKED } from './data/first-names.js';
import type { Detector, Finding } from './types.js';

const FIRST_NAMES = new Set(FIRST_NAMES_PACKED.split('|'));

/** Known first name, including compounds of known ones: Marie-Claire, Jean-Baptiste, Anna-Lena. */
/** First names that are also common words (Grace, Claire, Will): fine inside a compound, never alone. */
const AMBIGUOUS_FIRST_NAMES = new Set(AMBIGUOUS_FIRST_NAMES_PACKED.split('|'));

/** Known first name, including compounds such as Marie-Claire, Jean-Baptiste, Anna-Lena. */
const isFirstName = (w: string): boolean =>
  FIRST_NAMES.has(w) ||
  (w.includes('-') &&
    w.split('-').some((p) => FIRST_NAMES.has(p)) &&
    w.split('-').every((p) => FIRST_NAMES.has(p) || AMBIGUOUS_FIRST_NAMES.has(p.toLowerCase())));

/** Capitalized words that are never part of a person's name in these patterns. */
const NOT_NAME = new Set(
  `The A An And Or But If In On At To For Of With From By As Is Are Was Were Be Been I It We You He She They This That
  These Those My Your His Her Our Their Its Me Him Them Not No Yes Ok Okay Please Thanks Thank Hello Hi Hey Dear All
  Le La Les Un Une Des Du De Et Ou Mais Dans Sur Avec Pour Par Ce Cet Cette Ces Mon Ma Mes Ton Ta Tes Son Sa Ses Il Elle
  Nous Vous Ils Elles Je Tu On Oui Non Merci Bonjour Salut
  Der Die Das Den Dem Ein Eine Einen Und Oder Aber Mit Für Von Zu Im Am An Auf Bei Nach Ich Du Er Sie Es Wir Ihr Ja Nein
  Danke Bitte Hallo Liebe Lieber
  Monday Tuesday Wednesday Thursday Friday Saturday Sunday January February March April May June July August September
  October November December Lundi Mardi Mercredi Jeudi Vendredi Samedi Dimanche Janvier Février Mars Avril Mai Juin
  Juillet Août Septembre Octobre Novembre Décembre Montag Dienstag Mittwoch Donnerstag Freitag Samstag Sonntag Januar
  Februar März Juni Juli Oktober Dezember
  Street Road Avenue Lane Drive Way Boulevard Place Square Court Rue Straße Strasse Weg Platz Allee
  Team Teams Group Lab Labs Inc Ltd Llc Corp Company Gmbh University School College Institute Hospital Bank Studio
  Cloud Pro Plus Max Mini Air Prime Edition Version Update Model Engine Store Pay Play Music Video News Mail Maps Drive
  Docs Sheets Slides Pool Width Height Length Size Value Mode Router Server Client Test Tests Mock Code App Apps Api
  Day Night Week Month Year Morning Evening Today Tomorrow Everyone Everybody World There Guys Folks Friends Sir Madam
  Madame Monsieur Mademoiselle Colleagues Kollegen Kolleginnen Zusammen Tous Toutes Equipe Équipe
  Mr Mrs Ms Miss Mx Dr Prof Dame Mme Mlle Herr Frau M
  Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec Mon Tue Wed Thu Fri Sat Sun
  String Number Boolean Object Array Identifier Final None Optional Any Null Void Int Float List Dict Tuple Union
  Literal Error Exception License Public System Server Browser Session Sessions Linux Windows Mac Os Ios Android Sans
  Serif Mono Bold Italic Regular Light Medium Black Thin Code Studio Desktop Web Online Cli Sdk Ui Ux
  North South East West Northern Southern Eastern Western Central Upper Lower Greater New Old Saint St Santa San
  America Americas Africa Asia Europe Australia Norway Sweden Finland Denmark Iceland Germany France Spain Portugal
  Italy Austria Switzerland Belgium Netherlands Holland Luxembourg Poland Czech Slovakia Hungary Romania Bulgaria
  Greece Turkey Russia Ukraine Ireland England Scotland Wales Britain Canada Mexico Brazil Argentina Chile Peru
  Colombia China Japan Korea India Pakistan Iran Iraq Israel Egypt Morocco Algeria Tunisia Nigeria Kenya Ghana
  Senegal Cameroon Ethiopia Vietnam Thailand Indonesia Philippines Malaysia Singapore Zealand Arabia Emirates
  Kingdom States Republic Union Federation Island Islands Valley City County Province State Region`
    .split(/\s+/)
    .filter(Boolean),
);

/** Lowercase particles inside names: "de la Tour", "van der Berg", "von Weizsäcker". */
const PARTICLE = String.raw`(?:de|du|des|del|della|di|da|dos|das|van|von|der|den|ter|le|la|bin|ibn|al|el|zu|y)`;
/** A capitalized name word: Jane, O'Brien, McDonald, Marie-Claire, Müller. */
const WORD = String.raw`(?:\p{Lu}['’]|Mc|Mac|De|Di|Da|Du|La|Le|Van|Von|Fitz)?\p{Lu}\p{Ll}+(?:-(?:\p{Lu}['’]|Mc|Mac)?\p{Lu}\p{Ll}+)*`;
/** An all-caps surname as written on forms: DUPONT, LE GALL. */
const CAPS = String.raw`\p{Lu}{3,}(?:-\p{Lu}{2,})*`;
const NAME_PART = String.raw`(?:${WORD}|${CAPS})`;
/** One to three name parts, particles allowed between them. */
const SP = String.raw`[ \u00A0]`;
const NAME = String.raw`${NAME_PART}(?:${SP}(?:${PARTICLE}${SP}){0,2}${NAME_PART}){0,2}`;

const BEFORE = String.raw`(?<![\p{L}\p{N}_@./\\-])`;
const AFTER = String.raw`(?![\p{L}\p{N}_@])`;

const words = (s: string): string[] => s.split(/\s+/).filter((w) => w && !new RegExp(`^${PARTICLE}$`, 'u').test(w));

/** Drops trailing words that can't be part of a name, and the whole match if nothing name-like remains. */
function trimName(value: string): string | null {
  const parts = value.split(/(\s+)/);
  while (parts.length > 0 && NOT_NAME.has(capitalize(parts.at(-1) ?? ''))) parts.splice(-2);
  const trimmed = parts.join('').trim();
  if (!trimmed || words(trimmed).every((w) => NOT_NAME.has(capitalize(w)))) return null;
  if (NOT_NAME.has(capitalize(words(trimmed)[0] ?? ''))) return null;
  return trimmed;
}

const capitalize = (w: string): string => (w ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w);

/** Case-insensitive phrases without the `i` flag (which would also loosen \p{Lu} in the name part). */
const phrases = (list: string[]): string =>
  list
    .map((p) =>
      [...p]
        .map((c) => {
          if (c === ' ') return '\\s+';
          const up = c.toUpperCase();
          const low = c.toLowerCase();
          if (up === low || up.length !== 1) return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          return `[${up}${low}]`;
        })
        .join(''),
    )
    .join('|');

interface Rule {
  name: string;
  pattern: RegExp;
  /** Capture group with the name. */
  group: number;
  /** Extra check on the captured name. */
  accept?: (name: string) => boolean;
}

const RULES: Rule[] = [
  {
    // DUPONT Jean, LE GALL Maëlle (French forms)
    name: 'caps-surname-first',
    pattern: new RegExp(`${BEFORE}(?<!\\p{Lu}{2,}[ \\t]+)(${CAPS}(?:${SP}${CAPS})?${SP}(${WORD}))${AFTER}`, 'gdu'),
    group: 1,
    accept: (v) => {
      const parts = words(v);
      return isFirstName(parts.at(-1) ?? '') && parts.slice(0, -1).every((w) => !CAPS_NOT_SURNAME.has(w) && /[AEIOUYÀ-Ý]/u.test(w));
    },
  },
  {
    // Mr Smith, Mme Dupont, Herr Müller, Dr. Okafor (the title stays visible)
    name: 'title',
    pattern: new RegExp(
      `${BEFORE}(?:Mr|Mrs|Ms|Miss|Mx|Dr|Prof|Sir|Dame|Mme|Mlle|Herr|Frau|M\\.)\\.?${SP}(${NAME})${AFTER}`,
      'gdu',
    ),
    group: 1,
  },
  {
    // Hi Kofi, | Bonjour Amélie ! | Liebe Frau ... (greeting at the start of a line)
    name: 'greeting',
    pattern: new RegExp(
      `(?:^|\\n)[ \\t]*(?:${phrases(['dear', 'hi', 'hello', 'hey', 'bonjour', 'bonsoir', 'salut', 'coucou', 'cher', 'chère', 'hallo', 'liebe', 'lieber', 'moin', 'servus', 'ciao', 'hola', 'buongiorno'])})\\s+(${NAME})\\s*[,!\\n]`,
      'gdu',
    ),
    group: 1,
  },
  {
    // Best regards,\nJane Doe | Cordialement,\nMarie | Viele Grüße\nJonas
    name: 'sign-off',
    pattern: new RegExp(
      `(?:${phrases(['best regards', 'kind regards', 'warm regards', 'regards', 'best', 'cheers', 'thanks', 'thank you', 'sincerely', 'yours', 'cordialement', 'bien à vous', 'bien cordialement', 'amitiés', 'bisous', 'merci', 'bonne journée', 'viele grüße', 'liebe grüße', 'beste grüße', 'mit freundlichen grüßen', 'freundliche grüße', 'gruß', 'lg', 'vg', 'mfg'])})[,!.]?[ \\t]*\\n[ \\t]*(${NAME})[ \\t]*(?=\\n|$)`,
      'gdu',
    ),
    group: 1,
  },
  {
    // my name is Kofi Mensah | je m'appelle Maëlle | ich heiße Jonas
    name: 'introduction',
    pattern: new RegExp(
      `(?:${phrases(["my name is", "my name's", 'je m’appelle', "je m'appelle", 'je me nomme', 'mon nom est', 'ich heiße', 'ich heisse', 'mein name ist', 'me llamo', 'mi chiamo'])})\\s+(${NAME})${AFTER}`,
      'gdu',
    ),
    group: 1,
  },
  {
    // Name: Jane Doe | Nom : DUPONT Jean | Vorname: Jonas
    name: 'form-label',
    pattern: new RegExp(
      `(?:^|\\n)[ \\t]*(?:${phrases(['full name', 'name', 'nom complet', 'nom', 'prénom', 'vorname', 'nachname', 'patient', 'patiente'])})[ \\t]*:[ \\t]*(${NAME})${AFTER}(?![ \\t]*[;=|<>(){}\\[\\]?])`,
      'gdu',
    ),
    group: 1,
    // "name: String" in code: one word only counts when it is a known first name.
    accept: (v) => words(v).length > 1 || isFirstName(v) || AMBIGUOUS_FIRST_NAMES.has(v.toLowerCase()),
  },
];

/** "Jane Doe": a known first name, then one or two surname parts. Tried at every capitalized word. */
const FULL_NAME = new RegExp(`(${WORD}(?:${SP}(?:${PARTICLE}${SP}){0,2}${NAME_PART}){1,2})${AFTER}`, 'yu');
const WORD_START = new RegExp(`${BEFORE}\\p{Lu}`, 'gu');

/** Acronyms and shouted words that follow a first name without being a surname: "Trace CLI", "Jan UTC". */
const CAPS_NOT_SURNAME = new Set(
  `API APIS CLI SDK URL URI UTC GMT CET CEST PST PDT EST EDT CST HTTP HTTPS JSON XML HTML CSS SQL YAML TOML PDF CSV
  USA UK EU UN CEO CTO CFO COO VP HR IT PR QA FAQ TODO NOTE FIXME README LICENSE MIT BSD GPL LGPL AGPL MPL TTY GUI
  IDE OS AI ML LLM GPU CPU RAM SSD USB DNS TCP UDP SSH SSL TLS VPN AWS GCP IBM NASA ESA DIY ASAP FYI AKA ETA SHALL
  MUST SHOULD MAY NOT AND THE FOR WITH ALL ANY ARE YOU OUR NEW OLD`
    .split(/\s+/)
    .filter(Boolean),
);

/** An all-caps surname (Jean DUPONT) counts unless it is an acronym or part of a shouted sentence. */
function plausibleCapsSurname(text: string, start: number, end: number, rest: string[]): boolean {
  if (rest.some((w) => /^\p{Lu}+$/u.test(w) && (CAPS_NOT_SURNAME.has(w) || !/[AEIOUYÀ-Ý]/u.test(w)))) return false;
  if (/^[ \t]+\p{Lu}{2,}(?![\p{Ll}])/u.test(text.slice(end, end + 40))) return false;
  if (/\p{Lu}{2,}[ \t]+$/u.test(text.slice(Math.max(0, start - 40), start))) return false;
  return true;
}

function fullNames(text: string): Finding[] {
  const out: Finding[] = [];
  for (const start of text.matchAll(WORD_START)) {
    const at = start.index ?? 0;
    if (out.length > 0 && at < out.at(-1)!.end) continue; // inside a name already found
    FULL_NAME.lastIndex = at;
    const m = FULL_NAME.exec(text);
    if (!m?.[1]) continue;
    const value = trimName(m[1]);
    if (!value) continue;
    const [first, ...rest] = words(value);
    if (!first || !isFirstName(first) || rest.length === 0) continue;
    if (rest.some((w) => /^\p{Lu}+$/u.test(w)) && !plausibleCapsSurname(text, at, at + value.length, rest)) continue;
    out.push({ type: 'NAME', start: at, end: at + value.length, value, detector: 'name-full-name' });
  }
  return out;
}

export const names: Detector = {
  name: 'names',
  type: 'NAME',
  priority: 35,
  find(text) {
    const out = fullNames(text);
    for (const rule of RULES) {
      for (const m of text.matchAll(rule.pattern)) {
        const span = m.indices?.[rule.group];
        const raw = m[rule.group];
        if (!span || raw === undefined) continue;
        const value = trimName(raw);
        if (!value || (rule.accept && !rule.accept(value))) continue;
        out.push({ type: 'NAME', start: span[0], end: span[0] + value.length, value, detector: `name-${rule.name}` });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Postal addresses
// ---------------------------------------------------------------------------

const CITY = String.raw`\p{Lu}[\p{L}'’]+(?:[ -](?:\p{Lu}[\p{L}'’]+|sur|sous|en|le|la|les|am|an|der|im|bei|de|du))*`;
const FR_TYPES = phrases(['rue', 'avenue', 'av.', 'boulevard', 'bd', 'place', 'chemin', 'allée', 'impasse', 'quai', 'route', 'cours', 'square', 'passage', 'faubourg', 'rond-point', 'esplanade', 'promenade', 'voie', 'sentier', 'résidence', 'lotissement']);
const DE_SUFFIX = String.raw`(?:straße|strasse|str\.|weg|gasse|platz|allee|ring|damm|ufer|chaussee|steig|pfad)`;
const EN_TYPES = String.raw`(?:Street|St\.?|Avenue|Ave\.?|Road|Rd\.|Boulevard|Blvd\.?|Lane|Ln\.|Drive|Dr\.|Court|Ct\.|Way|Parkway|Pkwy\.?|Place|Pl\.|Terrace|Circle|Highway|Hwy\.?|Square|Sq\.|Close|Crescent|Gardens|Mews|Row)`;
const UK_POSTCODE = String.raw`[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}`;

const ADDRESS_PATTERNS: Array<[string, RegExp]> = [
  // 12 rue de la Paix, 75002 Paris | 3 bis avenue Jean Jaurès 69007 Lyon
  [
    'address-fr',
    new RegExp(
      `${BEFORE}\\d{1,3}(?:\\s?(?:bis|ter|b|B))?,?\\s+(?:${FR_TYPES})\\s+(?:[\\p{L}'’.-]+\\s?){1,6}?(?:,?\\s*\\d{5}\\s+${CITY}|(?=[,.;\\n]|$))`,
      'gu',
    ),
  ],
  // Musterstraße 12, 66123 Saarbrücken | Saarbrücker Straße 5a | Kaiserstr. 3
  [
    'address-de',
    new RegExp(
      `${BEFORE}(?:\\p{Lu}[\\p{L}-]*${DE_SUFFIX}|\\p{Lu}[\\p{L}-]+\\s+(?:Straße|Strasse|Str\\.|Weg|Gasse|Platz|Allee|Ring|Damm|Ufer))\\s+\\d{1,3}\\s?[a-z]?(?:,?\\s*(?:D-)?\\d{5}\\s+${CITY})?${AFTER}`,
      'gu',
    ),
  ],
  // 1600 Amphitheatre Parkway, Mountain View, CA 94043 | 10 Downing Street, London SW1A 2AA
  [
    'address-en',
    new RegExp(
      `${BEFORE}\\d{1,6}\\s+(?:[NSEW]\\.?\\s+)?(?:\\p{Lu}[\\p{L}'’.-]*\\s+){1,4}${EN_TYPES}(?![\\p{L}])(?:,?\\s+(?:Apt|Apartment|Suite|Ste|Unit|Flat)\\.?\\s*[\\w-]+)?(?:,\\s*${CITY},\\s*[A-Z]{2}\\s+\\d{5}(?:-\\d{4})?|,?\\s*${CITY}\\s+${UK_POSTCODE})?`,
      'gu',
    ),
  ],
  // PO Box 1234 | BP 45 | Postfach 1021
  ['po-box', /(?<![\p{L}\p{N}])(?:P\.?\s?O\.?\s?Box|BP|Postfach)\s+\d{1,6}(?![\p{N}])/gu],
];

export const addresses: Detector = {
  name: 'addresses',
  type: 'ADDRESS',
  priority: 45,
  find(text) {
    const out: Finding[] = [];
    for (const [name, pattern] of ADDRESS_PATTERNS) {
      for (const m of text.matchAll(pattern)) {
        const value = m[0].replace(/[\s,]+$/, '');
        const start = m.index ?? 0;
        out.push({ type: 'ADDRESS', start, end: start + value.length, value, detector: name });
      }
    }
    return out;
  },
};
