/** Renders the RN `Alert.alert` queue (rn/api.ts), one dialog at a time. */
import { useAlertStore } from './api';

export function AlertHost() {
  const req = useAlertStore((s) => s.queue[0]);
  const shift = useAlertStore((s) => s.shift);
  if (!req) return null;
  const press = (fn?: () => void) => {
    shift();
    fn?.();
  };
  const cancel = req.buttons.find((b) => b.style === 'cancel');
  const stacked = req.buttons.length > 2;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6"
      onClick={() => req.cancelable && press(cancel?.onPress)}
    >
      <div
        role="alertdialog"
        aria-labelledby={`alert-${req.id}`}
        className="w-full max-w-sm rounded-card bg-card p-5 shadow-xl dark:bg-card-dark"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={`alert-${req.id}`} className="text-base font-semibold text-ink dark:text-gray-100">
          {req.title}
        </h2>
        {req.message ? <p className="mt-2 whitespace-pre-wrap text-sm text-ink-2 dark:text-gray-300">{req.message}</p> : null}
        <div className={stacked ? 'mt-4 flex flex-col gap-2' : 'mt-4 flex justify-end gap-2'}>
          {req.buttons.map((b, i) => (
            <button
              key={i}
              autoFocus={b.style !== 'cancel' && i === req.buttons.length - 1}
              onClick={() => press(b.onPress)}
              className={[
                'rounded-control px-4 py-2 text-sm font-semibold',
                b.style === 'destructive'
                  ? 'text-alert dark:text-alert-dark'
                  : b.style === 'cancel'
                    ? 'text-ink-2 dark:text-gray-300'
                    : 'text-accent dark:text-emerald-400',
              ].join(' ')}
            >
              {b.text ?? 'OK'}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
