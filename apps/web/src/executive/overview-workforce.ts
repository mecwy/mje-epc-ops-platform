import { ROLE_KEYS, dec, peopleTotal } from '@mje/domain/rules';
export function workforceSummary(categories: Record<string, string>) {
  const total = peopleTotal(categories);
  if (total !== null)
    return {
      state: ROLE_KEYS.some(
        (key) => dec(categories[key]) === null && categories[key] !== 'na',
      )
        ? ('partial' as const)
        : ('complete' as const),
      value: total,
    };
  if (ROLE_KEYS.every((key) => !(categories[key] ?? '').trim()))
    return { state: 'blank' as const, value: null };
  if (ROLE_KEYS.every((key) => categories[key] === 'na'))
    return { state: 'na' as const, value: null };
  return { state: 'unknown' as const, value: null };
}
