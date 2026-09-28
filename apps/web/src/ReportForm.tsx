import type {
  AlphaDeclaration,
  AlphaRawCell,
  AlphaReportedSections,
} from '@mje/contracts';
import { blank, countFinding, followingDate } from './alpha-data.js';

interface Props {
  declaration: AlphaDeclaration;
  onChange: (value: AlphaDeclaration) => void;
  disabled: boolean;
  dateLocked: boolean;
}
function Cell({
  value,
  onChange,
  label,
}: {
  value: AlphaRawCell;
  onChange: (value: AlphaRawCell) => void;
  label: string;
}) {
  return (
    <div className="cell-input">
      <input
        aria-label={`${label}原值`}
        value={value.value ?? ''}
        disabled={value.state !== 'VALUE'}
        onChange={(event) =>
          onChange({ state: 'VALUE', value: event.target.value })
        }
      />
      <select
        aria-label={`${label}状态`}
        value={value.state}
        onChange={(event) =>
          onChange(
            event.target.value === 'VALUE'
              ? { state: 'VALUE', value: '' }
              : {
                  state: event.target.value as Exclude<
                    AlphaRawCell['state'],
                    'VALUE'
                  >,
                  value: null,
                },
          )
        }
      >
        <option value="BLANK">空白</option>
        <option value="VALUE">原报值</option>
        <option value="UNKNOWN">未知</option>
        <option value="NOT_APPLICABLE">不适用</option>
      </select>
    </div>
  );
}
export function ReportForm({
  declaration,
  onChange,
  disabled,
  dateLocked,
}: Props) {
  const sections = declaration.reportedSections!;
  const edit = (
    change: (copy: AlphaDeclaration, s: AlphaReportedSections) => void,
  ) => {
    const copy = structuredClone(declaration);
    change(copy, copy.reportedSections!);
    onChange(copy);
  };
  const source = (
    key: keyof Pick<
      AlphaReportedSections,
      | 'originalRecorder'
      | 'weather'
      | 'temperature'
      | 'reportedDuration'
      | 'sourceNote'
      | 'qualityText'
      | 'ehsText'
      | 'constructionText'
      | 'photoNotes'
    >,
    value: string,
  ) =>
    edit((_, s) => {
      s[key] = value;
    });
  return (
    <fieldset disabled={disabled} className="report-fieldset">
      <section className="card">
        <h2>基本信息与来源</h2>
        <div className="grid three">
          <label>
            业务日
            <input
              type="date"
              value={declaration.businessDate}
              disabled={dateLocked}
              onChange={(event) =>
                edit((d) => {
                  d.businessDate = event.target.value;
                  d.tomorrow.targetBusinessDate = followingDate(
                    event.target.value,
                  );
                })
              }
            />
          </label>
          <label>
            原文记录人
            <input
              value={sections.originalRecorder}
              onChange={(event) =>
                source('originalRecorder', event.target.value)
              }
              placeholder="空白即保留空白，不作为认证签名"
            />
          </label>
          <label>
            天气原报
            <input
              value={sections.weather}
              onChange={(event) => source('weather', event.target.value)}
            />
          </label>
          <label>
            温度原报
            <input
              value={sections.temperature}
              onChange={(event) => source('temperature', event.target.value)}
            />
          </label>
          <label>
            工期原报
            <input
              value={sections.reportedDuration}
              onChange={(event) =>
                source('reportedDuration', event.target.value)
              }
            />
          </label>
          <label>
            来源说明
            <input
              value={sections.sourceNote}
              onChange={(event) => source('sourceNote', event.target.value)}
            />
          </label>
        </div>
        <p className="hint">
          原 Word 的合同金额和收款栏属商务来源，本次日结不重新确认付款。
        </p>
      </section>
      <section className="card">
        <h2>工程量与明日计划</h2>
        <p className="muted">
          每日安装量逐行记录。区域是归属候选，百分比和单位按原报保存。
        </p>
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>项目</th>
                <th>区域 / 归属候选</th>
                <th>单位</th>
                <th>今日</th>
                <th>累计</th>
                <th>设计</th>
                <th>原报 %</th>
                <th>明日计划</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sections.progress.map((row, i) => (
                <tr key={row.id}>
                  <td>
                    <input
                      aria-label={`工程量${i + 1}项目`}
                      value={row.item}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.progress[i]!.item = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`工程量${i + 1}区域`}
                      value={row.scopeCandidate}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.progress[i]!.scopeCandidate = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`工程量${i + 1}单位`}
                      value={row.unit}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.progress[i]!.unit = e.target.value;
                        })
                      }
                    />
                  </td>
                  {(
                    [
                      'today',
                      'cumulative',
                      'designTotal',
                      'reportedPercent',
                      'nextPlan',
                    ] as const
                  ).map((key) => (
                    <td key={key}>
                      <Cell
                        label={`工程量${i + 1}${key}`}
                        value={row[key]}
                        onChange={(v) =>
                          edit((_, s) => {
                            s.progress[i]![key] = v;
                          })
                        }
                      />
                    </td>
                  ))}
                  <td>
                    <button
                      type="button"
                      onClick={() =>
                        edit((_, s) => {
                          s.progress.splice(i, 1);
                        })
                      }
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          onClick={() =>
            edit((_, s) => {
              s.progress.push({
                id: crypto.randomUUID(),
                item: '',
                scopeCandidate: '',
                unit: '',
                today: blank(),
                cumulative: blank(),
                designTotal: blank(),
                reportedPercent: blank(),
                nextPlan: blank(),
              });
            })
          }
        >
          ＋ 增加工程量行
        </button>
      </section>
      <section className="card">
        <h2>人员投入</h2>
        <p className="muted">
          分类和原报总计各自保存；差异仅提示核对，不推算人时。
        </p>
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>类别</th>
                <th>岗位 / 队伍</th>
                <th>原报人数</th>
                <th>归属候选</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sections.workforce.map((row, i) => (
                <tr key={row.id}>
                  <td>
                    <input
                      aria-label={`人员${i + 1}类别`}
                      value={row.category}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.workforce[i]!.category = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`人员${i + 1}岗位`}
                      value={row.role}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.workforce[i]!.role = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <Cell
                      label={`人员${i + 1}人数`}
                      value={row.count}
                      onChange={(v) =>
                        edit((_, s) => {
                          s.workforce[i]!.count = v;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`人员${i + 1}归属`}
                      value={row.scopeCandidate}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.workforce[i]!.scopeCandidate = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() =>
                        edit((_, s) => {
                          s.workforce.splice(i, 1);
                        })
                      }
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          onClick={() =>
            edit((_, s) => {
              s.workforce.push({
                id: crypto.randomUUID(),
                category: '',
                role: '',
                count: blank(),
                scopeCandidate: '',
              });
            })
          }
        >
          ＋ 增加人员行
        </button>
        <div className="grid">
          <label>
            原报总计
            <Cell
              label="原报总人数"
              value={declaration.reportedHeadcount}
              onChange={(v) =>
                edit((d) => {
                  d.reportedHeadcount = v;
                })
              }
            />
          </label>
          <label>
            分类差异说明
            <input
              value={declaration.headcountNote}
              onChange={(e) =>
                edit((d) => {
                  d.headcountNote = e.target.value;
                })
              }
            />
          </label>
        </div>
        <p className="hint">{countFinding(declaration)}</p>
      </section>
      <section className="card">
        <h2>机械使用</h2>
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>设备</th>
                <th>位置 / 归属候选</th>
                <th>原报数量</th>
                <th>备注</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sections.machines.map((row, i) => (
                <tr key={row.id}>
                  <td>
                    <input
                      aria-label={`机械${i + 1}设备`}
                      value={row.equipment}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.machines[i]!.equipment = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`机械${i + 1}位置`}
                      value={row.location}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.machines[i]!.location = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <Cell
                      label={`机械${i + 1}数量`}
                      value={row.count}
                      onChange={(v) =>
                        edit((_, s) => {
                          s.machines[i]!.count = v;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`机械${i + 1}备注`}
                      value={row.note}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.machines[i]!.note = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() =>
                        edit((_, s) => {
                          s.machines.splice(i, 1);
                        })
                      }
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          onClick={() =>
            edit((_, s) => {
              s.machines.push({
                id: crypto.randomUUID(),
                equipment: '',
                location: '',
                count: blank(),
                note: '',
              });
            })
          }
        >
          ＋ 增加机械行
        </button>
      </section>
      <section className="card">
        <h2>材料到场</h2>
        <p className="muted">到货与安装量分开；保留原单位和 0 / 空白差异。</p>
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>材料</th>
                <th>单位</th>
                <th>今日</th>
                <th>累计</th>
                <th>设计</th>
                <th>原报 %</th>
                <th>备注</th>
                <th>归属候选</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sections.materials.map((row, i) => (
                <tr key={row.id}>
                  <td>
                    <input
                      aria-label={`材料${i + 1}名称`}
                      value={row.item}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.materials[i]!.item = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`材料${i + 1}单位`}
                      value={row.unit}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.materials[i]!.unit = e.target.value;
                        })
                      }
                    />
                  </td>
                  {(
                    [
                      'today',
                      'cumulative',
                      'designTotal',
                      'reportedPercent',
                    ] as const
                  ).map((key) => (
                    <td key={key}>
                      <Cell
                        label={`材料${i + 1}${key}`}
                        value={row[key]}
                        onChange={(v) =>
                          edit((_, s) => {
                            s.materials[i]![key] = v;
                          })
                        }
                      />
                    </td>
                  ))}
                  <td>
                    <input
                      aria-label={`材料${i + 1}备注`}
                      value={row.note}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.materials[i]!.note = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`材料${i + 1}归属`}
                      value={row.scopeCandidate}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.materials[i]!.scopeCandidate = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() =>
                        edit((_, s) => {
                          s.materials.splice(i, 1);
                        })
                      }
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          onClick={() =>
            edit((_, s) => {
              s.materials.push({
                id: crypto.randomUUID(),
                item: '',
                unit: '',
                today: blank(),
                cumulative: blank(),
                designTotal: blank(),
                reportedPercent: blank(),
                note: '',
                scopeCandidate: '',
              });
            })
          }
        >
          ＋ 增加材料行
        </button>
      </section>
      <section className="card">
        <h2>重要节点</h2>
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>节点</th>
                <th>计划完成原报</th>
                <th>实际完成原报</th>
                <th>延期天数</th>
                <th>备注</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sections.milestones.map((row, i) => (
                <tr key={row.id}>
                  <td>
                    <input
                      aria-label={`节点${i + 1}名称`}
                      value={row.name}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.milestones[i]!.name = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`节点${i + 1}计划`}
                      value={row.plannedDate}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.milestones[i]!.plannedDate = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`节点${i + 1}实际`}
                      value={row.actualDate}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.milestones[i]!.actualDate = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <Cell
                      label={`节点${i + 1}延期`}
                      value={row.delayDays}
                      onChange={(v) =>
                        edit((_, s) => {
                          s.milestones[i]!.delayDays = v;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`节点${i + 1}备注`}
                      value={row.note}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.milestones[i]!.note = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() =>
                        edit((_, s) => {
                          s.milestones.splice(i, 1);
                        })
                      }
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          onClick={() =>
            edit((_, s) => {
              s.milestones.push({
                id: crypto.randomUUID(),
                name: '',
                plannedDate: '',
                actualDate: '',
                delayDays: blank(),
                note: '',
              });
            })
          }
        >
          ＋ 增加节点行
        </button>
      </section>
      <section className="card">
        <h2>质量、EHS 与施工情况</h2>
        <div className="grid">
          <label>
            质量要求 / 检查情况
            <textarea
              value={sections.qualityText}
              onChange={(e) => source('qualityText', e.target.value)}
            />
          </label>
          <label>
            EHS 措施 / 未关闭事项
            <textarea
              value={sections.ehsText}
              onChange={(e) => source('ehsText', e.target.value)}
            />
          </label>
          <label>
            当日施工情况
            <textarea
              value={sections.constructionText}
              onChange={(e) => source('constructionText', e.target.value)}
            />
          </label>
          <label>
            其他问题 / 待办
            <textarea
              value={declaration.issues}
              onChange={(e) =>
                edit((d) => {
                  d.issues = e.target.value;
                })
              }
            />
          </label>
          <label>
            明日安排
            <textarea
              value={declaration.tomorrow.text}
              onChange={(e) =>
                edit((d) => {
                  d.tomorrow.text = e.target.value;
                })
              }
            />
          </label>
        </div>
        <p className="hint">
          质量要求不等于验收通过；EHS 申报不等于许可或事项关闭。
        </p>
      </section>
      <section className="card">
        <h2>照片来源登记</h2>
        <p className="muted">
          只记录原报线索；不上传影像，不据此核实画面外的人数或全天出勤。
        </p>
        <div className="scroller">
          <table>
            <thead>
              <tr>
                <th>画面</th>
                <th>来源</th>
                <th>时间原报</th>
                <th>水印原文</th>
                <th>归属候选</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(sections.photoReferences ?? []).map((row, i) => (
                <tr key={row.id}>
                  <td>
                    <input
                      aria-label={`照片${i + 1}画面`}
                      value={row.description}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.photoReferences![i]!.description = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`照片${i + 1}来源`}
                      value={row.source}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.photoReferences![i]!.source = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`照片${i + 1}时间`}
                      value={row.reportedTakenAt}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.photoReferences![i]!.reportedTakenAt =
                            e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`照片${i + 1}水印`}
                      value={row.watermark}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.photoReferences![i]!.watermark = e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`照片${i + 1}归属`}
                      value={row.scopeCandidate}
                      onChange={(e) =>
                        edit((_, s) => {
                          s.photoReferences![i]!.scopeCandidate =
                            e.target.value;
                        })
                      }
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() =>
                        edit((_, s) => {
                          s.photoReferences!.splice(i, 1);
                        })
                      }
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          onClick={() =>
            edit((_, s) => {
              s.photoReferences ??= [];
              s.photoReferences.push({
                id: crypto.randomUUID(),
                description: '',
                source: '',
                reportedTakenAt: '',
                watermark: '',
                scopeCandidate: '',
              });
            })
          }
        >
          ＋ 增加照片来源行
        </button>
        <label>
          其他照片说明
          <textarea
            value={sections.photoNotes}
            onChange={(e) => source('photoNotes', e.target.value)}
          />
        </label>
      </section>
    </fieldset>
  );
}
