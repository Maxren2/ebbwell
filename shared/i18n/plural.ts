/** Plural forms keyed by CLDR category ("one", "two", "few"…); "#" is replaced by the number. */
export type PluralForms = { other: string } & Partial<Record<Intl.LDMLPluralRule, string>>;

export function plural(locale: string) {
  const rules = new Intl.PluralRules(locale);
  return (n: number, forms: PluralForms): string => (forms[rules.select(n)] ?? forms.other).replace('#', String(n));
}
