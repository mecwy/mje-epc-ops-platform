import { useI18n } from '../i18n.js';
import { shown } from '../report/format.js';
import type { ProjectStatus, StatusArea } from '@mje/contracts';
import type { ProjectHomeCard, ProjectHomeGroupBy } from '@mje/contracts';
export function projectGroupTitle(
  t: ReturnType<typeof useI18n>['t'],
  groupBy: ProjectHomeGroupBy,
  group: {
    key: string;
    projects: readonly Pick<ProjectHomeCard, 'managers'>[];
  },
) {
  if (group.key === '__UNASSIGNED__') {
    if (groupBy === 'region') return t('execNoRegion');
    if (groupBy === 'manager') return t('execUnassigned');
    return t('execNoType');
  }
  if (groupBy === 'manager') {
    const name = group.projects
      .flatMap((project) => project.managers)
      .find((manager) => manager.personId === group.key)?.displayName;
    return name?.trim() ? name : t('unknown');
  }
  return group.key;
}
export function overviewStatus(
  t: ReturnType<typeof useI18n>['t'],
  status: ProjectStatus,
) {
  switch (status) {
    case 'NORMAL':
      return t('execStatusNormal');
    case 'AT_RISK':
      return t('execStatusAtRisk');
    case 'OFF_TRACK':
      return t('execStatusOffTrack');
    case 'PAUSED':
      return t('execStatusPaused');
  }
}
export function overviewArea(
  t: ReturnType<typeof useI18n>['t'],
  area: StatusArea,
) {
  switch (area) {
    case 'SCHEDULE':
      return t('execAreaSchedule');
    case 'RESOURCE':
      return t('execAreaResource');
    case 'SAFETY':
      return t('execAreaSafety');
    case 'QUALITY':
      return t('execAreaQuality');
    case 'EXTERNAL':
      return t('execAreaExternal');
  }
}
/** Blank, unknown, N/A and explicit zero remain distinct. Never compute hours from people. */
export function OverviewValue({ value }: { value: string | null | undefined }) {
  const { t, locale } = useI18n();
  const display = shown(value ?? undefined, locale);
  return (
    <span className="num">
      {display.kind === 'blank'
        ? t('notFilled')
        : display.kind === 'token'
          ? t(display.token)
          : display.kind === 'number'
            ? display.text
            : display.raw}
    </span>
  );
}
