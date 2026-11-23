import en from './locales/en.json' with { type: 'json' };
import fr from './locales/fr.json' with { type: 'json' };
import de from './locales/de.json' with { type: 'json' };
import sv from './locales/sv.json' with { type: 'json' };
import ar from './locales/ar.json' with { type: 'json' };
import { PARAM_NAMES, PLURAL_PATHS } from './bindings.ts';
import type { Lang } from './index.ts';
import type { Messages } from './catalog-types.d.ts';

export type { Messages } from './catalog-types.d.ts';

const catalogs: Record<Lang, unknown> = { en, fr, de, sv, ar };
const pluralPaths = new Set<string>(PLURAL_PATHS);
const helperPaths = new Set([
  'rel.inDays_today',
  'rel.inDays_tomorrow',
  'admin.sso_configured',
  'admin.sso_notConfigured',
  'admin.connection_template',
  'admin.connection_networkLocal',
  'admin.connection_networkRemote',
  'admin.connection_routePublic',
  'admin.connection_routeDirect',
  'admin.connection_protocolSecure',
  'admin.connection_protocolPlain',
  'partner.ovulation_confirmed',
  'partner.ovulation_expected',
  'partner.stats_none',
  'partner.stats_sd',
  'partner.stats_period',
  'partner.stats_both',
  'partner.sharedBy_separator',
  'push.partner_named',
  'push.partner_unnamed',
]);

type Values = Record<string, unknown>;

function get(root: unknown, path: string): unknown {
  let value = root;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function text(root: unknown, path: string): string {
  const value = get(root, path);
  if (typeof value !== 'string') throw new Error(`Missing translation: ${path}`);
  return value;
}

function format(template: string, values: Values): string {
  return template.replace(/\{\{(\w+)\}\}/g, (placeholder, key: string) => {
    if (!Object.hasOwn(values, key) || values[key] === undefined || values[key] === null) {
      throw new Error(`Missing value for ${placeholder}`);
    }
    return String(values[key]);
  });
}

function pluralText(root: unknown, lang: Lang, path: string, count: number, values: Values, displayCount: unknown = count): string {
  const category = new Intl.PluralRules(lang).select(count);
  const template = get(root, `${path}_${category}`);
  if (typeof template !== 'string') throw new Error(`Missing plural translation: ${path}`);
  return format(template, { ...values, count: displayCount });
}

function relativeDays(root: unknown, lang: Lang, count: number): string {
  if (count === 0) return text(root, 'rel.today');
  if (count === 1) return text(root, 'rel.tomorrow');
  return pluralText(root, lang, 'rel.inDays', count, {});
}

function parameters(path: string): readonly string[] {
  return (PARAM_NAMES as Readonly<Record<string, readonly string[]>>)[path] ?? [];
}

function execute(root: unknown, lang: Lang, path: string, args: unknown[]): string {
  const names = parameters(path);
  const values = Object.fromEntries(names.map((name, index) => [name, args[index]]));

  if (pluralPaths.has(path)) {
    const template = get(root, path);
    if (typeof template === 'string') return format(template, values);
    const count = Number(args[0]);
    if (!Number.isFinite(count)) throw new Error(`Invalid plural count for ${path}`);
    if (path === 'rel.inDays' && (count === 0 || count === 1)) {
      const special = get(root, `${path}_${count === 0 ? 'today' : 'tomorrow'}`);
      if (typeof special === 'string') return special;
    }
    return pluralText(root, lang, path, count, values);
  }

  switch (path) {
    case 'chart.luteal':
    case 'insights.sd': {
      const count = Number(args[0]);
      const days = pluralText(root, lang, 'common.days', count, {}, Number.isFinite(count) ? count : args[0]);
      return format(text(root, path), { days });
    }
    case 'push.period':
      return format(text(root, path), { when: relativeDays(root, lang, Number(args[0])) });
    case 'push.partner': {
      const name = args[0];
      const template = text(root, `push.partner_${name ? 'named' : 'unnamed'}`);
      return format(template, {
        when: relativeDays(root, lang, Number(args[1])),
        ...(name ? { name } : {}),
      });
    }
    case 'admin.sso':
      return format(text(root, `admin.sso_${args[0] ? 'configured' : 'notConfigured'}`), { url: args[1] });
    case 'admin.connection':
      return format(text(root, path + '_template'), {
        network: text(root, `${path}_network${args[0] ? 'Local' : 'Remote'}`),
        route: text(root, `${path}_route${args[1] ? 'Public' : 'Direct'}`),
        protocol: text(root, `${path}_protocol${args[2] ? 'Secure' : 'Plain'}`),
      });
    case 'partner.ovulation':
      return format(text(root, `${path}_${args[0] ? 'confirmed' : 'expected'}`), { date: args[1] });
    case 'partner.stats': {
      const hasSd = args[1] !== null;
      const hasPeriod = args[4] !== null;
      const variant = hasSd ? (hasPeriod ? 'both' : 'sd') : hasPeriod ? 'period' : 'none';
      return format(text(root, `partner.stats_${variant}`), {
        mean: args[0],
        min: args[2],
        max: args[3],
        ...(hasSd ? { sd: args[1] } : {}),
        ...(hasPeriod ? { periodMean: args[4] } : {}),
      });
    }
    case 'partner.sharedBy': {
      const items = args[1];
      if (!Array.isArray(items)) throw new Error('Expected shared items to be a list');
      return format(text(root, path), {
        name: args[0],
        items: items.join(text(root, `${path}_separator`)),
      });
    }
    default:
      return format(text(root, path), values);
  }
}

function isPluralForm(path: string): boolean {
  const match = path.match(/_(zero|one|two|few|many|other)$/);
  return match !== null && pluralPaths.has(path.slice(0, -match[0].length));
}

function bindValue(root: unknown, lang: Lang, value: unknown, path: string): unknown {
  if (typeof value === 'string') {
    if (Object.hasOwn(PARAM_NAMES, path)) return (...args: unknown[]) => execute(root, lang, path, args);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => bindValue(root, lang, item, `${path}.${index}`));
  if (value === null || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (helperPaths.has(childPath) || isPluralForm(childPath)) continue;
    result[key] = bindValue(root, lang, nested, childPath);
  }

  for (const dynamicPath of Object.keys(PARAM_NAMES)) {
    const separator = dynamicPath.lastIndexOf('.');
    if (dynamicPath.slice(0, separator) !== path) continue;
    const key = dynamicPath.slice(separator + 1);
    if (!Object.hasOwn(result, key)) {
      result[key] = (...args: unknown[]) => execute(root, lang, dynamicPath, args);
    }
  }
  return result;
}

export function messagesFor(lang: Lang): Messages {
  const root = catalogs[lang];
  return bindValue(root, lang, root, '') as Messages;
}
