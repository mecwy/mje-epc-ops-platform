import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WorkspaceShell } from './WorkspaceShell.js';

it.each(['field', 'report', 'site'] as const)(
  'keeps recovery before %s content and overlays outside main without fabricating workflow state',
  (view) => {
    const html = renderToStaticMarkup(
      createElement(WorkspaceShell, {
        view,
        navigation: createElement(
          'nav',
          { 'aria-label': 'TEST nav' },
          'TEST navigation',
        ),
        header: createElement('span', null, 'TEST project <untrusted>'),
        recovery: createElement(
          'div',
          { role: 'alert' },
          'TEST outcome unknown; retry retained command',
        ),
        children: createElement('section', null, 'TEST existing day content'),
        overlays: createElement(
          'div',
          { role: 'dialog', 'aria-label': 'TEST correction' },
          'TEST original correction control',
        ),
      }),
    );
    expect(html).toContain(`workspace-page view-${view}`);
    expect(html).toContain('TEST project &lt;untrusted&gt;');
    expect(html.indexOf('TEST outcome unknown')).toBeLessThan(
      html.indexOf('TEST existing day content'),
    );
    expect(html.indexOf('</main>')).toBeLessThan(html.indexOf('role="dialog"'));
    expect(html.match(/<main/g)).toHaveLength(1);
    expect(html).not.toContain('aria-busy');
  },
);

it('uses the existing entry main landmark without nesting a second main', () => {
  const html = renderToStaticMarkup(
    createElement(WorkspaceShell, {
      view: 'report',
      containsMain: true,
      entry: true,
      navigation: null,
      header: null,
      children: createElement('main', null, 'TEST existing entry workflow'),
    }),
  );
  expect(html.match(/<main/g)).toHaveLength(1);
  expect(html).toContain('<div class="page workspace-page view-report">');
  expect(html).toContain('workspace-shell workspace-entry');
  expect(html).not.toContain('<header');
});
