/**
 * The stack header: left (the screen's headerLeft, mobile's BackHeaderLeft by
 * default), title, right — as the native stack draws it, with room for the
 * notch / status bar of a home-screen app.
 */
import type { ReactNode } from 'react';
import type { ScreenOptions } from '../router/router';
import { BackHeaderLeft } from '~/lib/goBack';

export function Header({ options, defaultTitle, isRoot }: { options: ScreenOptions; defaultTitle?: string; isRoot: boolean }) {
  const left: ReactNode = options.headerLeft === null ? null : options.headerLeft ? options.headerLeft() : isRoot ? null : BackHeaderLeft();
  const t = options.headerTitle ?? options.title ?? defaultTitle ?? '';
  const title: ReactNode = typeof t === 'function' ? t() : <span className="truncate text-base font-semibold text-ink dark:text-gray-100">{t}</span>;
  const center = options.headerTitleAlign === 'center';
  return (
    <header
      className="sticky top-0 z-30 flex min-h-[52px] items-center gap-2 border-b border-line bg-paper px-2 dark:border-line-dark dark:bg-paper-dark"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex min-w-[44px] items-center">{left}</div>
      <div className={['flex min-w-0 flex-1 items-center', center ? 'justify-center' : ''].join(' ')}>{title}</div>
      <div className="flex min-w-[44px] items-center justify-end gap-2 pr-1">{options.headerRight ? options.headerRight() : null}</div>
    </header>
  );
}
