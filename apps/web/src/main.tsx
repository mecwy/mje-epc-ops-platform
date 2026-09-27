import { createRoot } from 'react-dom/client';
const root = document.getElementById('root');
if (!root) throw new Error('Missing root');
createRoot(root).render(
  <main>
    <h1>MJE 新能源 EPC 经营平台</h1>
    <p>Phase 0 开发基线。业务功能、登录和离线提交尚未开放。</p>
    <a href="/health/live">检查 API 启动状态</a>
  </main>,
);
