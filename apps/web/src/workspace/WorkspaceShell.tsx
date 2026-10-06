import type { ReactNode } from 'react';

/** Presentation only. The owning workspace keeps authentication, day sessions and pending
 * commands mounted; navigation and dialogs are passed through without new business state. */
export function WorkspaceShell({
  navigation,
  header,
  recovery,
  children,
  overlays,
  view,
  containsMain = false,
  entry = false,
}: {
  navigation: ReactNode;
  header: ReactNode;
  recovery?: ReactNode;
  children: ReactNode;
  overlays?: ReactNode;
  view: 'field' | 'report' | 'site';
  containsMain?: boolean;
  entry?: boolean;
}) {
  const Content = containsMain ? 'div' : 'main';
  return (
    <div className={`workspace-shell${entry ? ' workspace-entry' : ''}`}>
      <div className="workspace-navigation">
        <div className="workspace-brand" aria-hidden="true">
          <span>M</span> MJE
        </div>
        {navigation}
      </div>
      <div className="content workspace-content">
        {header !== null && (
          <header className="bar workspace-header">{header}</header>
        )}
        <Content className={`page workspace-page view-${view}`}>
          {recovery}
          {children}
        </Content>
      </div>
      {overlays}
    </div>
  );
}
