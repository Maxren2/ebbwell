import { describe, expect, it } from 'vitest';
import { applyQuickEntry, isEmptyQuickEntry, onlyTracked, parseQuickEntry } from '../shared/quickentry.ts';
import { defaultSettings } from '../shared/schema.ts';

describe('quick entry', () => {
  it('reads an English sentence', () => {
    const q = parseQuickEntry('36.52 at 6:45, light bleeding, cramps and a headache, tired', 'en');
    expect(q).toMatchObject({
      temperature: { value: 36.52, time: '06:45' },
      bleeding: 'light',
      symptoms: ['cramps', 'headache', 'fatigue'],
      unknown: [],
    });
  });

  it('prefers the longest phrase and understands dictated decimals and Fahrenheit', () => {
    expect(parseQuickEntry('heavy period, period pain', 'en')).toMatchObject({ bleeding: 'heavy', symptoms: ['cramps'] });
    expect(parseQuickEntry('temperature 36 point 7', 'en').temperature).toEqual({ value: 36.7 });
    expect(parseQuickEntry('97.7 this morning', 'en').temperature).toEqual({ value: 36.5 });
    expect(parseQuickEntry('bleeding 12.5', 'en').temperature).toBeUndefined(); // not a body temperature
  });

  it('skips negated phrases, and only those', () => {
    const q = parseQuickEntry('no cramps, not tired, happy, sore breasts', 'en');
    expect(q.symptoms).toEqual(['breast_tenderness']);
    expect(q.mood).toEqual(['happy']);
    expect(parseQuickEntry('I have no energy', 'en').mood).toEqual(['low_energy']);
  });

  it('reads test results in either order and leaves an incomplete test as not understood', () => {
    expect(parseQuickEntry('LH test positive', 'en').lh).toBe('positive');
    expect(parseQuickEntry('negative pregnancy test', 'en').pregnancyTest).toBe('negative');
    const q = parseQuickEntry('did an LH test', 'en');
    expect(q.lh).toBeUndefined();
    expect(q.unknown).toEqual(['did', 'LH']);
  });

  it('reads mucus, sex and temperature disturbances', () => {
    const q = parseQuickEntry('egg white, wet, unprotected sex, slept badly, wine', 'en');
    expect(q).toMatchObject({ appearance: 'eggwhite', sensation: 'wet', sex: 'unprotected', disturbances: ['sleep', 'alcohol'] });
  });

  it('reads French, with or without accents', () => {
    const q = parseQuickEntry("36,48 à 6h30, règles abondantes, pas de crampes, mal de tête, fatiguée, test de grossesse négatif", 'fr');
    expect(q).toMatchObject({
      temperature: { value: 36.48, time: '06:30' },
      bleeding: 'heavy',
      symptoms: ['headache', 'fatigue'],
      pregnancyTest: 'negative',
      unknown: [],
    });
    expect(parseQuickEntry('regles legeres, glaire filante', 'fr')).toMatchObject({ bleeding: 'light', appearance: 'eggwhite' });
  });

  it('reads French as Whisper writes it', () => {
    const cases: [string, Record<string, unknown>][] = [
      [
        "36,52. Saignement léger, pas de crampe, mal à la tête et je suis fatiguée.",
        { temperature: { value: 36.52 }, bleeding: 'light', symptoms: ['headache', 'fatigue'], unknown: [] },
      ],
      [
        "Aujourd'hui j'ai mes règles, j'ai mal au ventre et mal aux seins, je suis un peu triste.",
        { bleeding: 'medium', symptoms: ['cramps', 'breast_tenderness'], mood: ['sad'], unknown: [] },
      ],
      [
        'Température 36,7. Glaire filante, sensation mouillée. Test d’ovulation positif.',
        { temperature: { value: 36.7 }, appearance: 'eggwhite', sensation: 'wet', lh: 'positive', unknown: [] },
      ],
      ['Petites règles, un peu de crampes, rapport sexuel non protégé.', { bleeding: 'light', symptoms: ['cramps'], sex: 'unprotected', unknown: [] }],
      ["Règles très abondantes. J'ai mal dormi.", { bleeding: 'heavy', disturbances: ['sleep'], unknown: [] }],
    ];
    for (const [text, expected] of cases) expect(parseQuickEntry(text, 'fr'), text).toMatchObject(expected);
  });

  it('reads German', () => {
    const q = parseQuickEntry('36,6 um 7:15, Schmierblutung, keine Kopfschmerzen, Rückenschmerzen, gereizt, LH-Test positiv', 'de');
    expect(q).toMatchObject({
      temperature: { value: 36.6, time: '07:15' },
      bleeding: 'spotting',
      symptoms: ['backache'],
      mood: ['irritable'],
      lh: 'positive',
      unknown: [],
    });
  });

  it('reads Arabic, including Arabic-Indic digits and the definite article', () => {
    const q = parseQuickEntry('٣٦٫٥ نزيف خفيف وصداع والم الظهر، تعبانة', 'ar');
    expect(q).toMatchObject({
      temperature: { value: 36.5 },
      bleeding: 'light',
      symptoms: ['headache', 'backache', 'fatigue'],
      unknown: [],
    });
    expect(parseQuickEntry('اختبار الحمل سلبي', 'ar').pregnancyTest).toBe('negative');
  });

  it('understands a sentence in another language than the interface', () => {
    expect(parseQuickEntry('Kopfschmerzen und müde', 'en').symptoms).toEqual(['headache', 'fatigue']);
  });

  it('reports what it did not understand', () => {
    const q = parseQuickEntry('went hiking with Sam', 'en');
    expect(isEmptyQuickEntry(q)).toBe(true);
    expect(q.unknown).toEqual(['went', 'hiking', 'Sam']);
  });

  it('merges into the day and drops what is not tracked', () => {
    const day = { bleeding: { value: 'medium' as const, exclude: true }, symptoms: ['acne' as const], temperature: { value: 36.4, time: '06:00' } };
    const q = parseQuickEntry('heavy bleeding, cramps, 36.55, dry, bad sleep', 'en');
    expect(applyQuickEntry(day, q)).toEqual({
      bleeding: { value: 'heavy', exclude: true },
      symptoms: ['acne', 'cramps'],
      temperature: { value: 36.55, time: '06:00', disturbances: ['sleep'] },
      mucus: { sensation: 'dry', appearance: 'none' },
    });
    const track = { ...defaultSettings().track, mucus: false, temperature: false };
    const kept = onlyTracked(q, track);
    expect(kept.sensation).toBeUndefined();
    expect(kept.temperature).toBeUndefined();
    expect(kept.disturbances).toEqual([]);
    expect(kept.symptoms).toEqual(['cramps']);
  });
});
