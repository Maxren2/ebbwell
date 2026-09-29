// Quick entry: turns a typed or dictated sentence ("36.52 at 6:45, light bleeding, cramps,
// tired") into day fields. It runs in the browser only; the text never goes to the server.
// Each language has a small vocabulary of everyday phrasings, matched longest phrase first,
// so "light bleeding" wins over "bleeding" and "sore breasts" over "sore".

import type { Lang } from './i18n/index.ts';
import { LANGUAGES } from './i18n/index.ts';
import type { Bleeding, DayData, Settings } from './schema.ts';
import { DISTURBANCES, MOODS, MUCUS_APPEARANCE, MUCUS_SENSATION, SYMPTOMS } from './schema.ts';

type Symptom = (typeof SYMPTOMS)[number];
type Mood = (typeof MOODS)[number];
type Disturbance = (typeof DISTURBANCES)[number];
type Sensation = (typeof MUCUS_SENSATION)[number];
type Appearance = (typeof MUCUS_APPEARANCE)[number];
type TestResult = 'negative' | 'positive';

export interface QuickEntry {
  /** Always °C (a Fahrenheit reading is converted). */
  temperature?: { value: number; time?: string };
  bleeding?: Bleeding;
  sensation?: Sensation;
  appearance?: Appearance;
  lh?: TestResult;
  pregnancyTest?: TestResult;
  sex?: 'protected' | 'unprotected';
  symptoms: Symptom[];
  mood: Mood[];
  disturbances: Disturbance[];
  /** Words that were not understood, as typed. */
  unknown: string[];
}

interface Lexicon {
  bleeding: Record<Bleeding, string[]>;
  sensation: Partial<Record<Sensation, string[]>>;
  appearance: Partial<Record<Appearance, string[]>>;
  symptoms: Record<Symptom, string[]>;
  mood: Record<Mood, string[]>;
  disturbances: Record<Disturbance, string[]>;
  sex: Record<'protected' | 'unprotected', string[]>;
  tests: Record<'lh' | 'pregnancyTest', string[]>;
  results: Record<TestResult, string[]>;
  /** "no cramps", "pas de crampes", "keine Kopfschmerzen": the phrase is skipped. */
  negators: string[];
  /** "36 point 5" as dictated. */
  decimal: string[];
  /** Filler words that are not reported as "not understood". */
  filler: string[];
}

const LEXICONS: Record<Lang, Lexicon> = {
  en: {
    bleeding: {
      spotting: ['spotting', 'spots of blood', 'brown discharge'],
      light: ['light bleeding', 'light period', 'light flow', 'bleeding lightly', 'little bleeding', 'a little bleeding'],
      medium: ['medium bleeding', 'medium flow', 'medium period', 'normal period', 'normal bleeding', 'moderate bleeding', 'moderate flow', 'on my period', 'period', 'bleeding', 'menstruation'],
      heavy: ['heavy bleeding', 'heavy period', 'heavy flow', 'bleeding heavily', 'strong bleeding'],
    },
    sensation: { dry: ['dry', 'feels dry'], moist: ['moist', 'damp', 'humid'], wet: ['wet', 'slippery', 'lubricated'] },
    appearance: { creamy: ['creamy', 'sticky', 'cloudy', 'thick mucus', 'white mucus', 'lotion like'], eggwhite: ['egg white', 'eggwhite', 'stretchy', 'clear mucus', 'raw egg'] },
    symptoms: {
      cramps: ['cramps', 'cramping', 'period pain', 'period cramps', 'abdominal pain', 'stomach ache', 'tummy ache', 'belly ache'],
      headache: ['headache', 'head ache', 'head hurts'],
      migraine: ['migraine'],
      backache: ['backache', 'back pain', 'back ache', 'sore back', 'lower back pain'],
      breast_tenderness: ['tender breasts', 'breast tenderness', 'sore breasts', 'breast pain', 'sore boobs'],
      bloating: ['bloating', 'bloated'],
      acne: ['acne', 'pimples', 'pimple', 'breakout', 'breakouts'],
      nausea: ['nausea', 'nauseous', 'queasy', 'sick to my stomach'],
      fatigue: ['fatigue', 'tired', 'exhausted', 'sleepy', 'fatigued'],
      cravings: ['cravings', 'craving', 'sugar cravings'],
      insomnia: ['insomnia', "couldn't sleep", 'could not sleep', 'sleepless', 'no sleep'],
      diarrhea: ['diarrhea', 'diarrhoea'],
      constipation: ['constipation', 'constipated'],
      ovulation_pain: ['ovulation pain', 'mittelschmerz', 'ovary pain'],
      hot_flashes: ['hot flashes', 'hot flushes', 'hot flash', 'hot flush'],
      dizziness: ['dizziness', 'dizzy', 'lightheaded', 'light headed'],
    },
    mood: {
      happy: ['happy', 'good mood', 'cheerful', 'joyful'],
      calm: ['calm', 'relaxed', 'peaceful'],
      energetic: ['energetic', 'full of energy', 'energized', 'energised'],
      sensitive: ['sensitive', 'emotional', 'teary', 'weepy'],
      irritable: ['irritable', 'irritated', 'grumpy', 'cranky', 'annoyed', 'moody', 'bad mood'],
      anxious: ['anxious', 'anxiety', 'worried', 'nervous'],
      sad: ['sad', 'depressed', 'unhappy', 'feeling down'],
      low_energy: ['low energy', 'no energy', 'sluggish', 'lethargic'],
      stressed: ['stressed', 'stress', 'under pressure'],
    },
    disturbances: {
      sleep: ['bad sleep', 'slept badly', 'slept poorly', 'short night', 'poor sleep', 'little sleep'],
      time: ['measured late', 'measured early', 'later than usual', 'earlier than usual'],
      alcohol: ['alcohol', 'drank', 'wine', 'beer'],
      illness: ['fever', 'ill', 'flu', 'sick'],
      travel: ['travel', 'travelling', 'traveling', 'jet lag', 'jetlag'],
      stress: [],
      medication: ['medication', 'medicine', 'painkiller', 'painkillers', 'ibuprofen'],
    },
    sex: {
      protected: ['protected sex', 'sex with condom', 'sex with a condom', 'condom'],
      unprotected: ['unprotected sex', 'sex without condom', 'sex without a condom', 'sex without protection', 'unprotected', 'not protected'],
    },
    tests: { lh: ['lh test', 'lh', 'ovulation test', 'opk'], pregnancyTest: ['pregnancy test', 'hcg test'] },
    results: { positive: ['positive', 'pos'], negative: ['negative', 'neg'] },
    negators: ['no', 'not', 'without', 'never', 'none'],
    decimal: ['point', 'dot'],
    filler: [
      'and', 'a', 'an', 'the', 'at', 'with', 'i', 'im', 'am', 'have', 'had', 'feel', 'feeling', 'felt', 'today', 'this', 'morning',
      'evening', 'some', 'bit', 'little', 'very', 'quite', 'my', 'me', 'of', 'in', 'on', 'temperature', 'temp', 'degrees', 'degree',
      'c', 'f', 'celsius', 'fahrenheit', 'mucus', 'discharge', 'cervical', 'slightly', 'also', 'but', 'was', 'is', 'it', 'so',
      'really', 'measured', 'woke', 'up', 'oclock', 'test', 'result', 'got', 'bbt', 'basal',
    ],
  },

  fr: {
    bleeding: {
      spotting: ['spotting', 'saignotement', 'saignotements', 'traces de sang', 'pertes brunes', 'petites pertes'],
      light: ['regles legeres', 'saignement leger', 'saignements legers', 'flux leger', 'regles faibles', 'peu de sang'],
      medium: ['regles moyennes', 'flux moyen', 'saignement moyen', 'regles normales', 'flux normal', 'j ai mes regles', 'regles', 'saignement', 'saignements', 'menstruation'],
      heavy: ['regles abondantes', 'flux abondant', 'saignement abondant', 'saignements abondants', 'regles fortes', 'beaucoup de sang', 'hemorragie'],
    },
    sensation: { dry: ['sec', 'seche', 'sensation seche', 'secheresse'], moist: ['humide', 'moite'], wet: ['mouille', 'mouillee', 'glissant', 'glissante', 'lubrifie', 'lubrifiee'] },
    appearance: {
      creamy: ['cremeuse', 'cremeux', 'collante', 'collant', 'epaisse', 'blanchatre', 'laiteuse', 'grumeleuse'],
      eggwhite: ['blanc d oeuf', 'blanc d œuf', 'filante', 'filantes', 'etirable', 'elastique', 'transparente', 'claire'],
    },
    symptoms: {
      cramps: ['crampes', 'douleurs de regles', 'mal au ventre', 'maux de ventre', 'douleurs abdominales', 'douleur abdominale'],
      headache: ['mal de tete', 'mal a la tete', 'maux de tete', 'cephalee'],
      migraine: ['migraine'],
      backache: ['mal de dos', 'mal au dos', 'maux de dos', 'douleur dorsale', 'lombalgie'],
      breast_tenderness: ['seins sensibles', 'seins douloureux', 'douleur aux seins', 'poitrine sensible', 'poitrine douloureuse'],
      bloating: ['ballonnements', 'ballonnee', 'ballonne', 'ventre gonfle', 'gonflee'],
      acne: ['acne', 'boutons', 'bouton'],
      nausea: ['nausee', 'nausees', 'envie de vomir', 'mal au coeur', 'mal au cœur'],
      fatigue: ['fatigue', 'fatiguee', 'epuisee', 'epuise', 'crevee'],
      cravings: ['fringales', 'fringale', 'envies de sucre', 'envie de sucre', 'grignotage'],
      insomnia: ['insomnie', 'pas dormi', 'nuit blanche'],
      diarrhea: ['diarrhee'],
      constipation: ['constipation', 'constipee', 'constipe'],
      ovulation_pain: ['douleur d ovulation', 'douleurs d ovulation', 'douleur ovulatoire', 'mal aux ovaires'],
      hot_flashes: ['bouffees de chaleur', 'bouffee de chaleur'],
      dizziness: ['vertiges', 'vertige', 'etourdissements', 'etourdie', 'tete qui tourne'],
    },
    mood: {
      happy: ['heureuse', 'heureux', 'contente', 'content', 'joyeuse', 'bonne humeur'],
      calm: ['calme', 'sereine', 'serein', 'detendue', 'detendu'],
      energetic: ['energique', 'pleine d energie', 'plein d energie', 'en forme', 'dynamique'],
      sensitive: ['sensible', 'emotive', 'a fleur de peau'],
      irritable: ['irritable', 'irritee', 'agacee', 'agace', 'enervee', 'mauvaise humeur', 'grognon'],
      anxious: ['anxieuse', 'anxieux', 'angoissee', 'inquiete', 'inquiet'],
      sad: ['triste', 'deprimee', 'deprime', 'cafard'],
      low_energy: ['sans energie', 'peu d energie', 'molle', 'apathique', 'a plat'],
      stressed: ['stressee', 'stresse', 'stress', 'sous pression'],
    },
    disturbances: {
      sleep: ['mal dormi', 'nuit courte', 'peu dormi', 'mauvaise nuit'],
      time: ['mesure plus tard', 'mesuree plus tard', 'mesure plus tot', 'plus tard que d habitude'],
      alcohol: ['alcool', 'vin', 'biere'],
      illness: ['fievre', 'malade', 'grippe', 'rhume'],
      travel: ['voyage', 'decalage horaire', 'en voyage'],
      stress: [],
      medication: ['medicament', 'medicaments', 'antidouleur', 'ibuprofene'],
    },
    sex: {
      protected: ['rapport protege', 'rapports proteges', 'sexe protege', 'avec preservatif', 'preservatif'],
      unprotected: ['rapport non protege', 'rapports non proteges', 'sexe non protege', 'sans preservatif', 'non protege'],
    },
    tests: { lh: ['test lh', 'test d ovulation', 'test ovulation', 'lh'], pregnancyTest: ['test de grossesse', 'test grossesse'] },
    results: { positive: ['positif', 'positive'], negative: ['negatif', 'negative'] },
    negators: ['pas', 'sans', 'aucun', 'aucune', 'ni', 'non'],
    decimal: ['virgule', 'point'],
    filler: [
      'et', 'un', 'une', 'le', 'la', 'les', 'l', 'de', 'des', 'du', 'd', 'a', 'au', 'aux', 'avec', 'je', 'j', 'ai', 'suis', 'me', 'm',
      'sens', 'peu', 'tres', 'assez', 'aujourd', 'hui', 'ce', 'matin', 'soir', 'ma', 'mon', 'mes', 'temperature', 'degres', 'degre',
      'glaire', 'pertes', 'cervicale', 'mesuree', 'mesure', 'h', 'heures', 'heure', 'vers', 'mais', 'aussi', 'il', 'y', 'est', 'un peu',
      'test', 'resultat', 'c', 'basale',
    ],
  },

  de: {
    bleeding: {
      spotting: ['schmierblutung', 'schmierblutungen', 'spotting', 'braunlicher ausfluss'],
      light: ['leichte blutung', 'schwache blutung', 'leichte periode', 'schwache periode', 'leichte menstruation', 'wenig blut'],
      medium: ['mittlere blutung', 'mittelstarke blutung', 'normale blutung', 'normale periode', 'meine tage', 'periode', 'blutung', 'menstruation', 'regelblutung', 'regel'],
      heavy: ['starke blutung', 'starke periode', 'heftige blutung', 'starke regel', 'viel blut'],
    },
    sensation: { dry: ['trocken'], moist: ['feucht'], wet: ['nass', 'rutschig', 'glitschig', 'schlupfrig'] },
    appearance: { creamy: ['cremig', 'klebrig', 'dicklich', 'weisslich', 'milchig'], eggwhite: ['spinnbar', 'eiweissartig', 'wie eiweiss', 'dehnbar', 'glasig', 'klar', 'durchsichtig'] },
    symptoms: {
      cramps: ['krampfe', 'krampf', 'unterleibsschmerzen', 'bauchkrampfe', 'periodenschmerzen', 'regelschmerzen', 'bauchschmerzen'],
      headache: ['kopfschmerzen', 'kopfschmerz', 'kopfweh'],
      migraine: ['migrane'],
      backache: ['ruckenschmerzen', 'ruckenschmerz', 'kreuzschmerzen'],
      breast_tenderness: ['brustspannen', 'empfindliche brust', 'empfindliche bruste', 'brustschmerzen', 'spannende brust'],
      bloating: ['blahungen', 'blahbauch', 'aufgeblaht'],
      acne: ['akne', 'pickel', 'unreine haut'],
      nausea: ['ubelkeit', 'ubel'],
      fatigue: ['mudigkeit', 'mude', 'erschopft', 'erschopfung', 'schlapp'],
      cravings: ['heisshunger', 'geluste', 'lust auf susses'],
      insomnia: ['schlaflosigkeit', 'schlaflos', 'nicht geschlafen', 'kaum geschlafen'],
      diarrhea: ['durchfall'],
      constipation: ['verstopfung', 'verstopft'],
      ovulation_pain: ['mittelschmerz', 'eisprungschmerz', 'eisprungschmerzen', 'ovulationsschmerz'],
      hot_flashes: ['hitzewallungen', 'hitzewallung'],
      dizziness: ['schwindel', 'schwindelig', 'schwindlig'],
    },
    mood: {
      happy: ['glucklich', 'froh', 'frohlich', 'gut gelaunt', 'gute laune'],
      calm: ['ruhig', 'entspannt', 'gelassen'],
      energetic: ['energiegeladen', 'voller energie', 'energisch', 'fit'],
      sensitive: ['empfindlich', 'sensibel', 'emotional', 'nah am wasser'],
      irritable: ['gereizt', 'reizbar', 'genervt', 'schlecht gelaunt', 'schlechte laune', 'launisch'],
      anxious: ['angstlich', 'besorgt', 'nervos', 'unruhig'],
      sad: ['traurig', 'niedergeschlagen', 'bedruckt', 'deprimiert'],
      low_energy: ['antriebslos', 'keine energie', 'wenig energie', 'lustlos', 'kraftlos'],
      stressed: ['gestresst', 'stress', 'unter druck'],
    },
    disturbances: {
      sleep: ['schlecht geschlafen', 'kurze nacht', 'wenig geschlafen', 'unruhige nacht'],
      time: ['spater gemessen', 'fruher gemessen', 'zu anderer zeit gemessen'],
      alcohol: ['alkohol', 'wein', 'bier', 'getrunken'],
      illness: ['fieber', 'krank', 'erkaltet', 'erkaltung', 'grippe'],
      travel: ['reise', 'gereist', 'zeitverschiebung', 'jetlag'],
      stress: [],
      medication: ['medikament', 'medikamente', 'schmerzmittel', 'ibuprofen', 'tablette'],
    },
    sex: {
      protected: ['geschutzter sex', 'geschutzter verkehr', 'mit kondom', 'kondom', 'verhutet'],
      unprotected: ['ungeschutzter sex', 'ungeschutzter verkehr', 'ohne kondom', 'ungeschutzt'],
    },
    tests: { lh: ['lh test', 'ovulationstest', 'eisprungtest', 'lh'], pregnancyTest: ['schwangerschaftstest'] },
    results: { positive: ['positiv'], negative: ['negativ'] },
    negators: ['kein', 'keine', 'keinen', 'keiner', 'nicht', 'ohne'],
    decimal: ['komma', 'punkt'],
    filler: [
      'und', 'ein', 'eine', 'einen', 'der', 'die', 'das', 'den', 'dem', 'um', 'mit', 'ich', 'bin', 'habe', 'hatte', 'fuhle', 'mich',
      'heute', 'morgen', 'abend', 'etwas', 'bisschen', 'sehr', 'ziemlich', 'mein', 'meine', 'temperatur', 'grad', 'zervixschleim',
      'schleim', 'ausfluss', 'gemessen', 'uhr', 'aber', 'auch', 'war', 'ist', 'es', 'test', 'ergebnis', 'c', 'basaltemperatur',
    ],
  },

  ar: {
    bleeding: {
      spotting: ['تبقيع', 'بقع دم', 'نقاط دم', 'افرازات بنيه'],
      light: ['نزيف خفيف', 'دوره خفيفه', 'حيض خفيف', 'دم قليل'],
      medium: ['نزيف متوسط', 'دوره متوسطه', 'دوره عاديه', 'دوره شهريه', 'حيض', 'نزيف'],
      heavy: ['نزيف غزير', 'نزيف شديد', 'دوره غزيره', 'حيض غزير', 'دم كثير'],
    },
    sensation: { dry: ['جاف', 'جافه', 'جفاف'], moist: ['رطب', 'رطبه', 'رطوبه'], wet: ['مبلل', 'مبلله', 'زلق', 'زلقه'] },
    appearance: { creamy: ['كريمي', 'كريميه', 'لزج', 'لزجه', 'ابيض كثيف'], eggwhite: ['بياض البيض', 'مطاطي', 'مطاطيه', 'شفاف', 'شفافه'] },
    symptoms: {
      cramps: ['تقلصات', 'مغص', 'الم البطن', 'الم الدوره', 'تشنجات'],
      headache: ['صداع', 'الم الراس'],
      migraine: ['شقيقه', 'صداع نصفي'],
      backache: ['الم الظهر', 'الام الظهر'],
      breast_tenderness: ['الم الثدي', 'الام الثدي', 'ثدي حساس', 'حساسيه الثدي'],
      bloating: ['انتفاخ', 'نفخه', 'منتفخه'],
      acne: ['حب الشباب', 'بثور', 'حبوب'],
      nausea: ['غثيان'],
      fatigue: ['تعب', 'تعبانه', 'متعبه', 'ارهاق', 'مرهقه'],
      cravings: ['رغبه في الاكل', 'شهيه', 'اشتهاء'],
      insomnia: ['ارق', 'لم انم'],
      diarrhea: ['اسهال'],
      constipation: ['امساك'],
      ovulation_pain: ['الم الاباضه'],
      hot_flashes: ['هبات ساخنه', 'هبات حراره'],
      dizziness: ['دوخه', 'دوار'],
    },
    mood: {
      happy: ['سعيد', 'سعيده', 'مبسوط', 'مبسوطه', 'فرحانه'],
      calm: ['هادي', 'هاديه', 'مرتاح', 'مرتاحه'],
      energetic: ['نشيط', 'نشيطه', 'طاقه عاليه'],
      sensitive: ['حساس', 'حساسه', 'عاطفيه'],
      irritable: ['عصبي', 'عصبيه', 'متضايقه', 'منزعج', 'منزعجه'],
      anxious: ['قلق', 'قلقه', 'متوتره'],
      sad: ['حزين', 'حزينه', 'مكتيب', 'مكتيبه'],
      low_energy: ['خموله', 'بدون طاقه', 'طاقه منخفضه', 'كسل'],
      stressed: ['مضغوط', 'مضغوطه', 'ضغط نفسي', 'توتر'],
    },
    disturbances: {
      sleep: ['نوم سيي', 'نمت قليلا', 'قله النوم', 'نوم متقطع'],
      time: ['قست متاخره', 'قست مبكره'],
      alcohol: ['كحول'],
      illness: ['حمي', 'حراره مرتفعه', 'مريض', 'مريضه', 'زكام', 'انفلونزا'],
      travel: ['سفر', 'فرق التوقيت'],
      stress: [],
      medication: ['دواء', 'ادويه', 'مسكن'],
    },
    sex: {
      protected: ['جماع محمي', 'علاقه محميه', 'واقي'],
      unprotected: ['جماع غير محمي', 'علاقه غير محميه', 'بدون واقي', 'غير محمي'],
    },
    tests: { lh: ['اختبار الاباضه', 'اختبار lh', 'lh'], pregnancyTest: ['اختبار الحمل', 'اختبار حمل'] },
    results: { positive: ['ايجابي', 'ايجابيه', 'موجب'], negative: ['سلبي', 'سلبيه', 'سالب'] },
    negators: ['لا', 'بدون', 'ليس', 'لم'],
    decimal: ['فاصلة', 'فاصله', 'فاصل'],
    filler: [
      'و', 'في', 'من', 'علي', 'مع', 'انا', 'عندي', 'لدي', 'اليوم', 'صباحا', 'مساء', 'ساعه', 'درجه', 'حراره', 'افرازات', 'قليلا',
      'جدا', 'شويه', 'كان', 'كانت', 'مخاط', 'عنق', 'رحم', 'اختبار', 'نتيجه',
    ],
  },
};

// ------------------------------------------------------------------ text normalisation

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/** Same number of characters as the input, so match positions stay valid. */
function westernDigits(text: string): string {
  return text
    .replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) & 0xf) % 10))
    .replace(/٫/g, '.') // Arabic decimal separator
    .replace(/،/g, ','); // Arabic comma
}

/** Lower case, no accents, Arabic letter variants unified; the article/conjunction prefixes dropped. */
function normalizeToken(token: string): string {
  let t = token
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ً-ٰٟـ]/g, '') // Arabic diacritics, tatweel
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ئ/g, 'ي')
    .replace(/ؤ/g, 'و');
  if (/^[؀-ۿ]/.test(t)) {
    if (t.startsWith('و') && t.length > 3) t = t.slice(1); // "and"
    const m = /^(?:[بلكف])?ال/.exec(t); // "the", "with the", "for the"…
    if (m && t.length - m[0].length >= 3) t = t.slice(m[0].length);
  }
  return t;
}

const tokensOf = (text: string) => [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0]);

/** Plurals and inflections: "cramp(s)", "crampe(s)", "müde/müder". Latin scripts only. */
function sameWord(text: string, lexeme: string): boolean {
  if (text === lexeme) return true;
  if (lexeme.length < 4 || !text.startsWith(lexeme) || /[؀-ۿ]/.test(lexeme)) return false;
  return /^(?:s|es|e|en|n|x|er|r)$/.test(text.slice(lexeme.length));
}

// ------------------------------------------------------------------ parsing

type Effect =
  | { kind: 'bleeding'; value: Bleeding }
  | { kind: 'sensation'; value: Sensation }
  | { kind: 'appearance'; value: Appearance }
  | { kind: 'symptom'; value: Symptom }
  | { kind: 'mood'; value: Mood }
  | { kind: 'disturbance'; value: Disturbance }
  | { kind: 'sex'; value: 'protected' | 'unprotected' }
  | { kind: 'test'; value: 'lh' | 'pregnancyTest' };

interface Phrase {
  words: string[];
  effect: Effect;
}

const phraseCache = new Map<Lang, Phrase[]>();

function phrasesFor(lang: Lang): Phrase[] {
  const cached = phraseCache.get(lang);
  if (cached) return cached;
  const lx = LEXICONS[lang];
  const out: Phrase[] = [];
  const add = (effect: Effect, list: string[] | undefined) => {
    for (const p of list ?? []) out.push({ words: tokensOf(p).map(normalizeToken), effect });
  };
  for (const [value, list] of Object.entries(lx.bleeding)) add({ kind: 'bleeding', value: value as Bleeding }, list);
  for (const [value, list] of Object.entries(lx.sensation)) add({ kind: 'sensation', value: value as Sensation }, list);
  for (const [value, list] of Object.entries(lx.appearance)) add({ kind: 'appearance', value: value as Appearance }, list);
  for (const [value, list] of Object.entries(lx.symptoms)) add({ kind: 'symptom', value: value as Symptom }, list);
  for (const [value, list] of Object.entries(lx.mood)) add({ kind: 'mood', value: value as Mood }, list);
  for (const [value, list] of Object.entries(lx.disturbances)) add({ kind: 'disturbance', value: value as Disturbance }, list);
  for (const [value, list] of Object.entries(lx.sex)) add({ kind: 'sex', value: value as 'protected' | 'unprotected' }, list);
  for (const [value, list] of Object.entries(lx.tests)) add({ kind: 'test', value: value as 'lh' | 'pregnancyTest' }, list);
  // Longest phrase first: "light bleeding" before "bleeding".
  out.sort((a, b) => b.words.length - a.words.length || b.words.join(' ').length - a.words.join(' ').length);
  phraseCache.set(lang, out);
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');

function parseIn(input: string, lang: Lang): { entry: QuickEntry; recognized: number } {
  const lx = LEXICONS[lang];
  const entry: QuickEntry = { symptoms: [], mood: [], disturbances: [], unknown: [] };
  let recognized = 0;
  let text = westernDigits(input);
  const blank = (m: RegExpExecArray) => {
    text = text.slice(0, m.index) + ' '.repeat(m[0].length) + text.slice(m.index + m[0].length);
  };

  // Temperature: "36.52", "36,52", "98.4", or dictated "36 point 52".
  const decimalWords = lx.decimal.map((w) => w.normalize('NFD').replace(/[̀-ͯ]/g, '')).join('|');
  const tempRe = new RegExp(`(?<![\\d.,:])(\\d{2,3})\\s*(?:[.,]|\\s(?:${decimalWords})\\s)\\s*(\\d{1,2})(?![\\d:])`, 'iu');
  const tm = tempRe.exec(text);
  if (tm) {
    const n = Number(`${tm[1]}.${tm[2]}`);
    const celsius = n >= 34 && n <= 42 ? n : n >= 93.2 && n <= 107.6 ? Math.round(((n - 32) * 5) / 9 * 1000) / 1000 : null;
    if (celsius !== null) {
      entry.temperature = { value: celsius };
      recognized++;
      blank(tm);
    }
  }
  // Time of the reading: "6:45", "06h45" (only kept with a temperature).
  const timeRe = /(?<![\d.,])([01]?\d|2[0-3])\s?[:h]\s?([0-5]\d)(?!\d)/iu;
  const tt = timeRe.exec(text);
  if (tt) {
    if (entry.temperature) entry.temperature.time = `${pad(Number(tt[1]))}:${tt[2]}`;
    blank(tt);
  }

  const raw = tokensOf(text);
  const norm = raw.map(normalizeToken);
  const used = new Array<boolean>(raw.length).fill(false);
  const negators = new Set(lx.negators.map(normalizeToken));
  const filler = new Set(lx.filler.map(normalizeToken));
  /** The negator right before position i, looking back past filler words only ("pas de crampes"). */
  const negatorBefore = (i: number): number | undefined => {
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      if (used[j]) return undefined;
      if (negators.has(norm[j]!)) return j;
      if (!filler.has(norm[j]!)) return undefined;
    }
    return undefined;
  };
  const results = Object.entries(lx.results).map(([value, list]) => ({ value: value as TestResult, words: list.map(normalizeToken) }));
  const tests: { at: number; end: number; value: 'lh' | 'pregnancyTest' }[] = [];
  const hits: { at: number; effect: Exclude<Effect, { kind: 'test' }> }[] = [];

  const matchesAt = (i: number, words: string[]) => words.every((w, k) => i + k < norm.length && !used[i + k] && sameWord(norm[i + k]!, w));

  for (const phrase of phrasesFor(lang)) {
    for (let i = 0; i + phrase.words.length <= norm.length; i++) {
      if (!matchesAt(i, phrase.words)) continue;
      const end = i + phrase.words.length;
      for (let k = i; k < end; k++) used[k] = true;
      // "no cramps", "pas de crampes": skip the phrase (and the negation).
      const negAt = negatorBefore(i);
      if (negAt !== undefined && phrase.effect.kind !== 'test') {
        for (let k = negAt; k < i; k++) used[k] = true;
        continue;
      }
      const e = phrase.effect;
      if (e.kind === 'test') {
        tests.push({ at: i, end, value: e.value });
        continue;
      }
      hits.push({ at: i, effect: e });
    }
  }

  // In the order of the sentence; for single values the first mention wins.
  for (const { effect: e } of hits.sort((a, b) => a.at - b.at)) {
    recognized++;
    if (e.kind === 'bleeding') entry.bleeding ??= e.value;
    else if (e.kind === 'sensation') entry.sensation ??= e.value;
    else if (e.kind === 'appearance') entry.appearance ??= e.value;
    else if (e.kind === 'sex') entry.sex ??= e.value;
    else if (e.kind === 'symptom' && !entry.symptoms.includes(e.value)) entry.symptoms.push(e.value);
    else if (e.kind === 'mood' && !entry.mood.includes(e.value)) entry.mood.push(e.value);
    else if (e.kind === 'disturbance' && !entry.disturbances.includes(e.value)) entry.disturbances.push(e.value);
  }

  // "LH test positive", "positive pregnancy test", "test de grossesse négatif".
  for (const test of tests) {
    const near = [test.end, test.end + 1, test.end + 2, test.at - 1, test.at - 2].filter((j) => j >= 0 && j < norm.length && !used[j]);
    const hit = near.map((j) => ({ j, r: results.find((r) => r.words.some((w) => sameWord(norm[j]!, w))) })).find((x) => x.r);
    if (!hit) {
      for (let k = test.at; k < test.end; k++) used[k] = false; // reported as not understood
      continue;
    }
    used[hit.j] = true;
    entry[test.value] = hit.r!.value;
    recognized++;
  }

  entry.unknown = raw.filter((_, i) => !used[i] && !filler.has(norm[i]!) && !/^\d+$/.test(norm[i]!));
  return { entry, recognized };
}

/**
 * Reads the sentence in the user's language, and in the other languages too (people dictate
 * in whichever language comes naturally); the reading that understands the most wins.
 */
export function parseQuickEntry(text: string, preferred: Lang): QuickEntry {
  let best = parseIn(text, preferred);
  for (const lang of LANGUAGES) {
    if (lang === preferred) continue;
    const other = parseIn(text, lang);
    if (other.recognized > best.recognized) best = other;
  }
  return best.entry;
}

export function isEmptyQuickEntry(q: QuickEntry): boolean {
  return (
    !q.temperature && !q.bleeding && !q.sensation && !q.appearance && !q.lh && !q.pregnancyTest && !q.sex &&
    !q.symptoms.length && !q.mood.length && !q.disturbances.length
  );
}

/** Drops what the user chose not to track (those sections are hidden in the day editor). */
export function onlyTracked(q: QuickEntry, track: Settings['track']): QuickEntry {
  return {
    ...q,
    temperature: track.temperature ? q.temperature : undefined,
    disturbances: track.temperature ? q.disturbances : [],
    sensation: track.mucus ? q.sensation : undefined,
    appearance: track.mucus ? q.appearance : undefined,
    lh: track.lh ? q.lh : undefined,
    pregnancyTest: track.pregnancyTest ? q.pregnancyTest : undefined,
    sex: track.sex ? q.sex : undefined,
    symptoms: track.symptoms ? q.symptoms : [],
    mood: track.mood ? q.mood : [],
  };
}

/** Merges into the day: single values are replaced, lists are added to. */
export function applyQuickEntry(day: DayData, q: QuickEntry): DayData {
  const out: DayData = { ...day };
  if (q.bleeding) out.bleeding = { ...day.bleeding, value: q.bleeding };
  const temperature = q.temperature ? { ...day.temperature, ...q.temperature } : day.temperature;
  if (temperature) {
    const disturbances = [...new Set([...(temperature.disturbances ?? []), ...q.disturbances])];
    out.temperature = { ...temperature, ...(disturbances.length ? { disturbances } : {}) };
  }
  if (q.sensation || q.appearance) {
    out.mucus = {
      ...day.mucus,
      sensation: q.sensation ?? day.mucus?.sensation ?? 'nothing',
      appearance: q.appearance ?? day.mucus?.appearance ?? 'none',
    };
  }
  if (q.lh) out.lh = q.lh;
  if (q.pregnancyTest) out.pregnancyTest = q.pregnancyTest;
  if (q.sex) out.sex = q.sex;
  if (q.symptoms.length) out.symptoms = [...new Set([...(day.symptoms ?? []), ...q.symptoms])];
  if (q.mood.length) out.mood = [...new Set([...(day.mood ?? []), ...q.mood])];
  return out;
}
