import { z } from 'zod';
import { isIsoDate } from './dates.ts';

export const BLEEDING = ['spotting', 'light', 'medium', 'heavy'] as const;
export const DISTURBANCES = ['sleep', 'time', 'alcohol', 'illness', 'travel', 'stress', 'medication'] as const;
export const MUCUS_SENSATION = ['dry', 'nothing', 'moist', 'wet'] as const;
export const MUCUS_APPEARANCE = ['none', 'creamy', 'eggwhite'] as const;
export const SYMPTOMS = [
  'cramps', 'headache', 'migraine', 'backache', 'breast_tenderness', 'bloating', 'acne', 'nausea',
  'fatigue', 'cravings', 'insomnia', 'diarrhea', 'constipation', 'ovulation_pain', 'hot_flashes', 'dizziness',
] as const;
export const MOODS = ['happy', 'calm', 'energetic', 'sensitive', 'irritable', 'anxious', 'sad', 'low_energy', 'stressed'] as const;

export const isoDate = z.string().refine(isIsoDate, 'Expected a YYYY-MM-DD date');

export const DayDataSchema = z
  .object({
    bleeding: z
      .object({
        value: z.enum(BLEEDING),
        /** Bleeding that should not count as a period (e.g. breakthrough bleeding). */
        exclude: z.boolean().optional(),
      })
      .strict()
      .optional(),
    temperature: z
      .object({
        /** Always stored in °C; converted for display. */
        value: z.number().min(34).max(42),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
        exclude: z.boolean().optional(),
        disturbances: z.array(z.enum(DISTURBANCES)).max(DISTURBANCES.length).optional(),
      })
      .strict()
      .optional(),
    mucus: z
      .object({
        sensation: z.enum(MUCUS_SENSATION),
        appearance: z.enum(MUCUS_APPEARANCE),
        exclude: z.boolean().optional(),
      })
      .strict()
      .optional(),
    cervix: z
      .object({
        opening: z.enum(['closed', 'medium', 'open']).optional(),
        firmness: z.enum(['hard', 'soft']).optional(),
        position: z.enum(['low', 'medium', 'high']).optional(),
      })
      .strict()
      .optional(),
    lh: z.enum(['negative', 'positive']).optional(),
    pregnancyTest: z.enum(['negative', 'positive']).optional(),
    sex: z.enum(['protected', 'unprotected']).optional(),
    symptoms: z.array(z.enum(SYMPTOMS)).max(SYMPTOMS.length).optional(),
    mood: z.array(z.enum(MOODS)).max(MOODS.length).optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();

export type DayData = z.infer<typeof DayDataSchema>;
export type Bleeding = (typeof BLEEDING)[number];

export interface DayEntry {
  date: string;
  data: DayData;
}

export const SettingsSchema = z
  .object({
    goal: z.enum(['track', 'conceive', 'avoid']).default('track'),
    /** Pregnancy / postpartum / pause: no predictions. */
    paused: z.boolean().default(false),
    temperatureUnit: z.enum(['C', 'F']).default('C'),
    track: z
      .object({
        temperature: z.boolean().default(true),
        mucus: z.boolean().default(true),
        cervix: z.boolean().default(false),
        lh: z.boolean().default(true),
        pregnancyTest: z.boolean().default(true),
        sex: z.boolean().default(true),
        symptoms: z.boolean().default(true),
        mood: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    /** User confirmed they learned the symptothermal method (unlocks the NFP evaluation). */
    nfpAcknowledged: z.boolean().default(false),
    /** Cycle start dates excluded from statistics (after the pill, postpartum, illness…). */
    excludedCycles: z.array(isoDate).max(1000).default([]),
    defaultCycleLength: z.number().int().min(18).max(60).default(28),
    defaultPeriodLength: z.number().int().min(1).max(12).default(5),
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;

export const defaultSettings = (): Settings => SettingsSchema.parse({});

/** Removes empty sub-objects/arrays so an "empty" day can be deleted. */
export function isEmptyDay(data: DayData): boolean {
  return Object.values(data).every(
    (v) => v === undefined || v === '' || (Array.isArray(v) && v.length === 0) ||
      (typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => x === undefined)),
  );
}
