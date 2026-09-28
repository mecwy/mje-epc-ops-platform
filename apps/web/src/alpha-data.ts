import type {
  AlphaDeclaration,
  AlphaRawCell,
  AlphaReportedSections,
} from '@mje/contracts';

export const blank = (): AlphaRawCell => ({ state: 'BLANK', value: null });
export function followingDate(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
export function freshDeclaration(): AlphaDeclaration {
  const sections: AlphaReportedSections = {
    originalRecorder: '',
    weather: '',
    temperature: '',
    reportedDuration: '',
    sourceNote: '',
    progress: [],
    workforce: [],
    machines: [],
    materials: [],
    milestones: [],
    photoReferences: [],
    qualityText: '',
    ehsText: '',
    constructionText: '',
    photoNotes: '',
  };
  return {
    businessDate: '',
    deviceRecordedAt: null,
    workItems: [],
    reportedHeadcount: blank(),
    headcountNote: '',
    issues: '',
    tomorrow: { targetBusinessDate: '', text: '' },
    reportedSections: sections,
  };
}
export function editableDeclaration(value: AlphaDeclaration): AlphaDeclaration {
  const copy = structuredClone(value);
  copy.reportedSections ??= freshDeclaration().reportedSections!;
  copy.reportedSections.photoReferences ??= [];
  return copy;
}
export function cellText(cell: AlphaRawCell): string {
  switch (cell.state) {
    case 'VALUE':
      return cell.value;
    case 'BLANK':
      return '空白';
    case 'UNKNOWN':
      return '未知';
    case 'NOT_APPLICABLE':
      return '不适用';
  }
}
export function countFinding(declaration: AlphaDeclaration): string {
  const rows = declaration.reportedSections?.workforce ?? [];
  const total = declaration.reportedHeadcount;
  if (
    rows.length === 0 ||
    total.state !== 'VALUE' ||
    !/^\d+$/.test(total.value) ||
    rows.some(
      (row) => row.count.state !== 'VALUE' || !/^\d+$/.test(row.count.value),
    )
  )
    return '分类或原报总计未填完整；不推断实际自然人数。';
  const sum = rows.reduce((value, row) => value + BigInt(row.count.value!), 0n);
  const reported = BigInt(total.value);
  return sum === reported
    ? `分类算术和 ${sum} 与原报总计相同；尚未核实自然人或人时。`
    : `分类算术和 ${sum} 与原报总计 ${reported} 不同；两组原值均保留，待人工核对。`;
}
