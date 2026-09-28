import { useEffect, useState } from 'react';
import type { AccountInfo } from '@azure/msal-browser';
import type { AlphaDeclaration, SaveAlphaCommand } from '@mje/contracts';
import { AlphaAuth } from './alpha-auth.js';
import {
  ApiError,
  api,
  type AuthConfig,
  type Project,
  type ProjectsResponse,
  type SaveResponse,
  type SiteDayDetail,
  type SiteDaySummary,
} from './alpha-api.js';
import {
  cellText,
  countFinding,
  editableDeclaration,
  freshDeclaration,
} from './alpha-data.js';
import { ReportForm } from './ReportForm.js';

type Screen = 'login' | 'home' | 'edit' | 'preview' | 'detail';
function explain(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'FORBIDDEN':
        return '账号没有当前项目的录入权限；输入仍保留。';
      case 'VERSION_CONFLICT':
        return '版本已在别处更新；输入仍保留。请回查最新版本。';
      case 'IDEMPOTENCY_KEY_REUSED':
        return '重试请求与原请求不同。请先核对服务器上的记录。';
      case 'CORRECTION_REASON_REQUIRED':
        return '更正版本必须填写原因。';
      case 'LOGIN_REQUIRED':
        return '登录已过期；请重新登录后重试。';
      case 'INVALID_INPUT':
        return '录入内容未通过校验；请检查必填项和原报值。';
      default:
        return `请求未完成（${error.code}）。`;
    }
  }
  if (error instanceof Error && error.message === 'LOGIN_REQUIRED')
    return '登录已过期；请重新登录后重试。';
  if (error instanceof Error && error.message === 'ACCOUNT_CHANGED')
    return '请选择原账号继续此记录；输入和请求仍保留。';
  return '网络或服务暂时不可用；未确认保存成功。输入和原请求已保留。';
}
function summary(d: AlphaDeclaration, project?: Project): string {
  const s = d.reportedSections;
  const out = [
    `项目：${project?.name ?? '未选'} · 业务日：${d.businessDate || '未填'} · 工地时区：${project?.timezone ?? '未选'}`,
    `原文记录人：${s?.originalRecorder || '空白'}（不是认证签名） · 来源：${s?.sourceNote || '空白'}`,
    `天气：${s?.weather || '空白'} · 温度：${s?.temperature || '空白'} · 工期：${s?.reportedDuration || '空白'}`,
    '',
    '【工程量：今日 / 累计 / 设计 / 原报% / 明日计划】',
  ];
  s?.progress.forEach((r, i) =>
    out.push(
      `${i + 1}. ${r.item || '未命名'} · ${r.scopeCandidate || '归属待确认'} · ${r.unit || '单位空白'}：${cellText(r.today)} / ${cellText(r.cumulative)} / ${cellText(r.designTotal)} / ${cellText(r.reportedPercent)} / ${cellText(r.nextPlan)}`,
    ),
  );
  d.workItems.forEach((r, i) =>
    out.push(
      `原简表 ${i + 1}. ${r.description} · ${r.area || '归属待确认'} · ${cellText(r.quantity)} ${r.unit}`,
    ),
  );
  out.push('', '【人员分类及原报总计】');
  s?.workforce.forEach((r) =>
    out.push(
      `${r.category} ${r.role || '未填'}：${cellText(r.count)}；${r.scopeCandidate || '归属待确认'}`,
    ),
  );
  out.push(
    `原报总计：${cellText(d.reportedHeadcount)}`,
    countFinding(d),
    `差异说明：${d.headcountNote || '空白'}`,
    '',
    '【机械】',
  );
  s?.machines.forEach((r) =>
    out.push(
      `${r.equipment || '未命名'} · ${r.location || '位置空白'} · ${cellText(r.count)} · ${r.note || '备注空白'}`,
    ),
  );
  out.push('', '【材料：今日 / 累计 / 设计 / 原报%】');
  s?.materials.forEach((r) =>
    out.push(
      `${r.item || '未命名'} · ${r.unit || '单位空白'}：${cellText(r.today)} / ${cellText(r.cumulative)} / ${cellText(r.designTotal)} / ${cellText(r.reportedPercent)} · ${r.scopeCandidate || '归属待确认'}`,
    ),
  );
  out.push('', '【重要节点】');
  s?.milestones.forEach((r) =>
    out.push(
      `${r.name || '未命名'} · 计划 ${r.plannedDate || '空白'} · 实际 ${r.actualDate || '空白'} · 延期 ${cellText(r.delayDays)} · ${r.note || '备注空白'}`,
    ),
  );
  out.push(
    '',
    '【质量、EHS、施工】',
    `质量：${s?.qualityText || '空白；不算已验收'}`,
    `EHS：${s?.ehsText || '空白；不算已关闭'}`,
    `施工：${s?.constructionText || '空白'}`,
    `其他问题：${d.issues || '空白'}`,
    `明日安排：${d.tomorrow.text || '空白'}`,
    '',
    '【照片来源登记】',
  );
  s?.photoReferences?.forEach((r) =>
    out.push(
      `${r.description || '未命名'} · 来源 ${r.source || '空白'} · 时间 ${r.reportedTakenAt || '空白'} · 水印 ${r.watermark || '空白'} · ${r.scopeCandidate || '归属待确认'}`,
    ),
  );
  out.push(`照片说明：${s?.photoNotes || '空白'}`);
  return out.join('\n');
}

export function App() {
  const [auth, setAuth] = useState<AlphaAuth | null>(null);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [screen, setScreen] = useState<Screen>('login');
  const [message, setMessage] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [records, setRecords] = useState<SiteDaySummary[]>([]);
  const [recordId, setRecordId] = useState('');
  const [version, setVersion] = useState(0);
  const [baseRevision, setBaseRevision] = useState<number | null>(null);
  const [declaration, setDeclaration] =
    useState<AlphaDeclaration>(freshDeclaration);
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState<SiteDayDetail | null>(null);
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [pending, setPending] = useState<SaveAlphaCommand | null>(null);
  const project = projects.find((item) => item.id === projectId);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const response = await fetch('/api/auth-config', { cache: 'no-store' });
        const config = (await response.json()) as AuthConfig;
        if (!config.enabled) {
          if (active) setAvailable(false);
          return;
        }
        const client = await AlphaAuth.create(config);
        if (!active) return;
        setAuth(client);
        setAvailable(true);
        const current = client.current();
        if (current) {
          setAccount(current);
          await loadProjects(client, current);
        }
      } catch (error) {
        if (active) setMessage(explain(error));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (screen !== 'edit' && screen !== 'preview' && !pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [screen, pending]);

  async function request<T>(
    client: AlphaAuth,
    user: AccountInfo,
    path: string,
    command?: SaveAlphaCommand,
  ): Promise<T> {
    const token = await client.token(user);
    return api<T>(path, token, command);
  }
  async function loadProjects(client: AlphaAuth, user: AccountInfo) {
    const result = await request<ProjectsResponse>(
      client,
      user,
      '/api/projects',
    );
    setProjects(result.projects);
    const chosen =
      result.projects.find((p) => p.id === projectId) ?? result.projects[0];
    setProjectId(chosen?.id ?? '');
    setScreen('home');
    if (chosen) await loadList(client, user, chosen.id);
  }
  async function loadList(
    client: AlphaAuth,
    user: AccountInfo,
    selected: string,
  ) {
    setRecords(
      await request<SiteDaySummary[]>(
        client,
        user,
        `/api/site-days?projectId=${encodeURIComponent(selected)}`,
      ),
    );
  }
  async function signIn() {
    if (!auth) return;
    setBusy(true);
    setMessage('');
    try {
      const user = await auth.signIn();
      if (account && user.homeAccountId !== account.homeAccountId)
        throw new Error('ACCOUNT_CHANGED');
      setAccount(user);
      if (!account || screen === 'login') await loadProjects(auth, user);
    } catch (error) {
      setMessage(explain(error));
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    if (!auth || !account) return;
    setBusy(true);
    try {
      await auth.signOut(account);
      setAccount(null);
      setProjects([]);
      setRecords([]);
      setScreen('login');
      setMessage('');
    } catch (error) {
      setMessage(explain(error));
    } finally {
      setBusy(false);
    }
  }
  async function chooseProject(value: string) {
    if (!auth || !account) return;
    setProjectId(value);
    setBusy(true);
    setMessage('');
    try {
      await loadList(auth, account, value);
    } catch (error) {
      setMessage(explain(error));
    } finally {
      setBusy(false);
    }
  }
  function newRecord() {
    setRecordId(crypto.randomUUID());
    setVersion(0);
    setBaseRevision(null);
    setDeclaration(freshDeclaration());
    setReason('');
    setDetail(null);
    setPending(null);
    setMessage('');
    setScreen('edit');
  }
  async function openRecord(id: string) {
    if (!auth || !account) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await request<SiteDayDetail>(
        auth,
        account,
        `/api/site-days/${id}`,
      );
      setDetail(result);
      setRecordId(result.id);
      setVersion(result.version);
      setBaseRevision(result.currentRevisionNumber || null);
      setDeclaration(editableDeclaration(result.content.declaration));
      setReason('');
      setPending(null);
      setSelectedRevision(result.revisions.at(-1)?.revisionNumber ?? null);
      setScreen('detail');
    } catch (error) {
      setMessage(explain(error));
    } finally {
      setBusy(false);
    }
  }
  async function submit(command: SaveAlphaCommand) {
    if (!auth || !account) {
      setMessage('请先登录。输入仍保留。');
      return;
    }
    setBusy(true);
    setMessage('');
    setPending(command);
    try {
      const result = await request<SaveResponse>(
        auth,
        account,
        '/api/site-days/save',
        command,
      );
      setPending(null);
      setVersion(result.version);
      setBaseRevision(result.revisionNumber || null);
      setMessage(
        result.status === 'DRAFT'
          ? '草稿已由服务器确认保存。'
          : `版本 v${result.revisionNumber} 已保存，待复核。`,
      );
      try {
        const saved = await request<SiteDayDetail>(
          auth,
          account,
          `/api/site-days/${result.recordId}`,
        );
        setDetail(saved);
        setSelectedRevision(saved.revisions.at(-1)?.revisionNumber ?? null);
        setDeclaration(editableDeclaration(saved.content.declaration));
        setScreen('detail');
        if (projectId) await loadList(auth, account, projectId);
      } catch {
        setMessage('服务器已确认保存，但回查暂时失败。请从列表重新打开记录。');
        setScreen('home');
      }
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.status < 500 &&
        error.status !== 401
      )
        setPending(null);
      setMessage(explain(error));
    } finally {
      setBusy(false);
    }
  }
  function save(action: SaveAlphaCommand['action']) {
    if (!projectId || !declaration.businessDate) {
      setMessage('请先选择项目和业务日。');
      return;
    }
    if (action === 'SAVE_VERSION' && baseRevision && !reason.trim()) {
      setMessage('更正版本必须填写原因。');
      return;
    }
    void submit({
      recordId,
      projectId,
      expectedVersion: version,
      baseRevisionNumber: baseRevision,
      clientMutationId: crypto.randomUUID(),
      action,
      reason,
      declaration: structuredClone(declaration),
    });
  }
  const shownRevision = detail?.revisions.find(
    (r) => r.revisionNumber === selectedRevision,
  );
  return (
    <>
      <header>
        <div>
          <strong>MJE EPC</strong>
          <small>现场日结 · 本人 Alpha</small>
        </div>
        {account && (
          <div className="account">
            <span>{account.username}</span>
            <button onClick={() => void signIn()} disabled={busy}>
              重新登录
            </button>
            <button
              onClick={() => void signOut()}
              disabled={busy || pending !== null}
            >
              退出
            </button>
          </div>
        )}
      </header>
      <main>
        <div className="notice">
          手工申报与原值保留。保存版本处于待复核状态，不代表工程验收、工时核实、计费或付款授权。
        </div>
        {message && (
          <div role="status" className="status">
            {message}
          </div>
        )}
        {loading && (
          <section className="card">
            <h1>正在检查登录配置…</h1>
          </section>
        )}
        {!loading && !available && (
          <section className="card">
            <h1>现场日结尚未启用</h1>
            <p>
              当前服务没有启用本人 Alpha 登录。请使用已配置的 Dev
              环境；页面不会使用模拟账号保存业务数据。
            </p>
          </section>
        )}
        {!loading && available && (screen === 'login' || !account) && (
          <section className="card login">
            <p className="step">01 / 身份</p>
            <h1>登录后记录现场事实</h1>
            <p>使用已获授权的 Microsoft 账号；项目权限由服务器核验。</p>
            <button
              className="primary"
              onClick={() => void signIn()}
              disabled={busy}
            >
              {busy ? '正在登录…' : '使用 Microsoft 登录'}
            </button>
          </section>
        )}
        {!loading && available && account && screen === 'home' && (
          <>
            <div className="bar">
              <div>
                <p className="step">02 / 工作台</p>
                <h1>现场日结</h1>
              </div>
              <button
                className="primary"
                onClick={newRecord}
                disabled={!projectId || busy}
              >
                ＋ 新建日报
              </button>
            </div>
            <section className="card">
              <label>
                当前项目
                <select
                  value={projectId}
                  onChange={(e) => void chooseProject(e.target.value)}
                  disabled={busy}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.code} · {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted">
                报送项目只是范围。任务、人员和照片的具体归属仍待分别确认。
              </p>
              {projects.length === 0 ? (
                <p>当前账号没有已授权项目。</p>
              ) : records.length === 0 ? (
                <p>这里还没有日报。未报不代表现场没有施工。</p>
              ) : (
                <div className="record-list">
                  {records.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => void openRecord(r.id)}
                      disabled={busy}
                    >
                      <strong>{r.businessDate}</strong>
                      <span>
                        {r.status === 'DRAFT'
                          ? '草稿'
                          : `待复核 v${r.currentRevisionNumber}`}
                      </span>
                      <span>查看</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
        {!loading && available && account && screen === 'edit' && (
          <>
            <div className="bar">
              <div>
                <p className="step">03 / 按 Word 栏目录入</p>
                <h1>{version ? '继续编辑 / 更正' : '新建日报'}</h1>
              </div>
              <span className="badge">
                {baseRevision ? `基于 v${baseRevision}` : '草稿'}
              </span>
            </div>
            <p className="muted">
              工地时区：{project?.timezone ?? '未选'}。原报
              0、空白、未知、不适用分别保存；不自动推算工时。
            </p>
            <ReportForm
              declaration={declaration}
              onChange={setDeclaration}
              disabled={busy || pending !== null}
              dateLocked={version > 0}
            />
            <section className="card">
              <label>
                更正原因（首次版本留空）
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={busy || pending !== null}
                />
              </label>
              <div className="actions">
                <button
                  onClick={() => save('SAVE_DRAFT')}
                  disabled={busy || pending !== null}
                >
                  保存草稿
                </button>
                <button
                  className="primary"
                  onClick={() => {
                    setMessage('');
                    setScreen('preview');
                  }}
                  disabled={busy || pending !== null}
                >
                  预览原报并保存版本
                </button>
                <button
                  onClick={() => setScreen('home')}
                  disabled={busy || pending !== null}
                >
                  返回列表
                </button>
              </div>
              {pending && (
                <div className="hint">
                  <p>上次请求尚未确认。请原样重试，避免产生重复版本。</p>
                  <button onClick={() => void submit(pending)} disabled={busy}>
                    重试同一次请求
                  </button>
                </div>
              )}
            </section>
          </>
        )}
        {!loading && available && account && screen === 'preview' && (
          <>
            <p className="step">04 / 保存前核对</p>
            <h1>预览原报内容</h1>
            <pre className="summary">{summary(declaration, project)}</pre>
            <p className="notice">
              提交后快照不可覆盖；更正生成新版本并保留旧版本。
            </p>
            <div className="actions">
              <button
                className="primary"
                onClick={() => save('SAVE_VERSION')}
                disabled={busy || pending !== null}
              >
                确认保存版本
              </button>
              <button
                onClick={() => setScreen('edit')}
                disabled={busy || pending !== null}
              >
                返回修改
              </button>
            </div>
            {pending && (
              <div className="hint">
                <p>保存结果尚未确认。请重试同一次请求。</p>
                <button onClick={() => void submit(pending)} disabled={busy}>
                  重试原请求
                </button>
              </div>
            )}
          </>
        )}
        {!loading && available && account && screen === 'detail' && detail && (
          <>
            <div className="bar">
              <div>
                <p className="step">05 / 历史与更正</p>
                <h1>
                  {detail.businessDate} ·{' '}
                  {detail.currentRevisionNumber
                    ? `待复核 v${detail.currentRevisionNumber}`
                    : '草稿'}
                </h1>
              </div>
              <button onClick={() => setScreen('home')}>返回列表</button>
            </div>
            <section className="card">
              <p>当前草稿 / 最新录入内容</p>
              <pre className="summary">
                {summary(detail.content.declaration, project)}
              </pre>
              <button
                onClick={() => {
                  setDeclaration(
                    editableDeclaration(detail.content.declaration),
                  );
                  setBaseRevision(detail.currentRevisionNumber || null);
                  setReason('');
                  setScreen('edit');
                }}
              >
                编辑并建立新版本
              </button>
            </section>
            {detail.revisions.length > 0 && (
              <section className="card">
                <h2>已保存版本</h2>
                <div className="actions">
                  {detail.revisions.map((r) => (
                    <button
                      key={r.id}
                      onClick={() => setSelectedRevision(r.revisionNumber)}
                      className={
                        selectedRevision === r.revisionNumber ? 'selected' : ''
                      }
                    >
                      查看 v{r.revisionNumber}
                    </button>
                  ))}
                </div>
                {shownRevision && (
                  <>
                    <p className="muted">
                      保存时间：
                      {new Date(shownRevision.createdAt).toLocaleString()} ·
                      更正原因：{shownRevision.reason || '首次版本'}
                    </p>
                    <pre className="summary">
                      {summary(shownRevision.snapshot.declaration, project)}
                    </pre>
                    <button
                      onClick={() => {
                        setDeclaration(
                          editableDeclaration(
                            shownRevision.snapshot.declaration,
                          ),
                        );
                        setBaseRevision(shownRevision.revisionNumber);
                        setReason('');
                        setScreen('edit');
                      }}
                    >
                      基于 v{shownRevision.revisionNumber} 更正
                    </button>
                  </>
                )}
              </section>
            )}
          </>
        )}
      </main>
      <footer>
        现场日结 Alpha · 原始申报待核查 · 关闭 AI 也可录入、保存和回查
      </footer>
    </>
  );
}
