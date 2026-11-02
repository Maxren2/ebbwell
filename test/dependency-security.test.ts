import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
interface MergeOptions {
  clone?: boolean;
  arrayMerge?: (target: unknown[], source: unknown[]) => unknown[];
  customMerge?: (key: string) => ((target: unknown, source: unknown) => unknown) | undefined;
}
interface Merge {
  (target: object, source: object, options?: MergeOptions): Record<PropertyKey, unknown>;
  all: (objects: object[]) => Record<PropertyKey, unknown>;
}
const merge: Merge = require('deepmerge');

it('keeps the legacy filelist consumer compatible with patched minimatch', () => {
  const jakeRequire = createRequire(require.resolve('jake/package.json'));
  const { FileList }: { FileList: new (pattern: string) => { exclude: (pattern: RegExp) => void; toArray: () => string[] } } = jakeRequire('filelist');
  const dir = mkdtempSync(join(tmpdir(), 'ebbwell-filelist-'));
  try {
    writeFileSync(join(dir, 'keep.js'), '');
    writeFileSync(join(dir, 'skip.js'), '');
    const files = new FileList(join(dir, '*.js'));
    files.exclude(/skip\.js$/);
    expect(files.toArray().map((file) => file.replaceAll('\\', '/'))).toEqual([join(dir, 'keep.js').replaceAll('\\', '/')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('patched build dependency (GHSA-gcqx-w48m-w2h4)', () => {
  it('resolves the patched local package through the dependency override', () => {
    expect(require('deepmerge/package.json').version).toBe('4.3.2-ebbwell.1');
  });

  it.each([true, false])('does not poison the prototype when copying target keys (clone=%s)', (clone) => {
    const target = JSON.parse('{"__proto__":{"polluted":true},"normal":1}');
    const result = merge(target, { other: 2 }, { clone });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.polluted).toBeUndefined();
    expect(result.normal).toBe(1);
    expect(result.other).toBe(2);
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('does not poison the prototype when copying source keys into a null-prototype target', () => {
    const result = merge(Object.create(null), JSON.parse('{"__proto__":{"polluted":true}}'));
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('protects nested objects and array elements', () => {
    const result = merge(JSON.parse('{"nested":{"__proto__":{"polluted":true}},"list":[{"__proto__":{"polluted":true}}]}'), {});
    const nested = result.nested as Record<string, unknown>;
    const first = (result.list as Record<string, unknown>[])[0]!;
    expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    expect(nested.polluted).toBeUndefined();
    expect(first.polluted).toBeUndefined();
  });

  it('preserves deep merging, arrays, symbols, and special values', () => {
    const symbol = Symbol('option');
    const date = new Date();
    const result = merge({ nested: { a: 1 }, list: [1], [symbol]: { a: 1 } }, { nested: { b: 2 }, list: [2], [symbol]: { b: 2 }, date });
    expect(result).toEqual({ nested: { a: 1, b: 2 }, list: [1, 2], [symbol]: { a: 1, b: 2 }, date });
    expect(result.date).toBe(date);
    expect(merge.all([{ a: 1 }, { b: 2 }])).toEqual({ a: 1, b: 2 });
  });

  it('preserves custom merge options used by build plugins', () => {
    expect(merge({ list: [1] }, { list: [2] }, { arrayMerge: (_, source) => source })).toEqual({ list: [2] });
    expect(merge({ option: { a: 1 } }, { option: { b: 2 } }, {
      customMerge: (key) => key === 'option' ? (_, source) => source : undefined,
    })).toEqual({ option: { b: 2 } });
  });
});
