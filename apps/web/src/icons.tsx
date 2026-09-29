import type { ReactNode } from 'react';

const svg = (size: number, width: number, children: ReactNode) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={width}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);
export const Icon = {
  left: () => svg(20, 2, <polyline points="15 18 9 12 15 6" />),
  right: () => svg(20, 2, <polyline points="9 18 15 12 9 6" />),
  down: () => svg(18, 2, <polyline points="6 9 12 15 18 9" />),
  back: () =>
    svg(
      22,
      2,
      <>
        <line x1="19" y1="12" x2="5" y2="12" />
        <polyline points="12 19 5 12 12 5" />
      </>,
    ),
  more: () =>
    svg(
      20,
      2,
      <>
        <circle cx="5" cy="12" r="1" />
        <circle cx="12" cy="12" r="1" />
        <circle cx="19" cy="12" r="1" />
      </>,
    ),
  check: () => svg(18, 2.5, <polyline points="20 6 9 17 4 12" />),
  alert: () =>
    svg(
      18,
      2.2,
      <>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </>,
    ),
  close: () =>
    svg(
      20,
      2,
      <>
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </>,
    ),
  field: () =>
    svg(
      22,
      1.9,
      <>
        <rect x="8" y="2" width="8" height="4" rx="1" />
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      </>,
    ),
  report: () =>
    svg(
      22,
      1.9,
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
      </>,
    ),
};
