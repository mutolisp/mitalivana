/**
 * A screen that throws shows what went wrong and a way home instead of
 * blanking the whole app; the database and other screens are unaffected.
 */
import { Component, type ReactNode } from 'react';
import i18n from '../host/i18n';
import { router } from '../router/router';

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  componentDidCatch(error: Error) {
    console.error('[screen]', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-xl space-y-3 p-6 text-ink dark:text-gray-100">
        <p className="font-semibold">{i18n.t('web.home.error')}</p>
        <pre className="whitespace-pre-wrap rounded-card bg-card p-3 text-xs dark:bg-card-dark">{String(this.state.error.message)}</pre>
        <button className="rounded-control bg-accent px-4 py-2 text-sm font-semibold text-white" onClick={() => router.replace('/')}>
          {i18n.t('web.home.title')}
        </button>
      </div>
    );
  }
}
